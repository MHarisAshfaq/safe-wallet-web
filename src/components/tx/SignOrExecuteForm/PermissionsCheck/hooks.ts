import useAsync from '@/hooks/useAsync'
import useSafeInfo from '@/hooks/useSafeInfo'
import { useWeb3ReadOnly } from '@/hooks/wallets/web3'
import { Errors, logError } from '@/services/exceptions'
import { getModuleTransactionId } from '@/services/transactions'
import { backOff } from 'exponential-backoff'
import { useEffect, useMemo } from 'react'
import {
  type ChainId,
  chains,
  fetchRolesMod,
  Clearance,
  type RoleSummary,
  ExecutionOptions,
  Status,
} from 'zodiac-roles-deployments'
import {
  OperationType,
  type Transaction,
  type MetaTransactionData,
  type SafeTransaction,
} from '@safe-global/safe-core-sdk-types'
import { type JsonRpcProvider } from 'ethers'
import { KnownContracts, getModuleInstance } from '@gnosis.pm/zodiac'
import useWallet from '@/hooks/wallets/useWallet'
import { useHasFeature } from '@/hooks/useChains'
import { FEATURES } from '@/utils/chains'
import { decodeMultiSendTxs } from '@/utils/transactions'
import { encodeMultiSendData } from '@safe-global/protocol-kit'
import { Multi_send__factory } from '@/types/contracts'

const ROLES_V2_SUPPORTED_CHAINS = Object.keys(chains)
const multiSendInterface = Multi_send__factory.createInterface()

/**
 * Turns a Safe Transaction into a set of meta transactions, unbundling multisend calls
 */
export const useMetaTransactions = (safeTx?: SafeTransaction): MetaTransactionData[] => {
  const safeTxData = safeTx?.data
  return useMemo(() => {
    if (!safeTxData) return []

    const metaTx: MetaTransactionData = {
      to: safeTxData.to,
      value: safeTxData.value,
      data: safeTxData.data,
      operation: safeTxData.operation,
    }

    if (metaTx.operation === OperationType.DelegateCall) {
      // try decoding as multisend
      try {
        const baseTransactions = decodeMultiSendTxs(metaTx.data)
        if (baseTransactions.length > 0) {
          return baseTransactions.map((tx) => ({ ...tx, operation: OperationType.Call }))
        }
      } catch (e) {}
    }

    return [metaTx]
  }, [safeTxData])
}

/**
 * Returns all Zodiac Roles Modifiers v2 instances that are enabled and correctly configured on this Safe
 */
export const useRolesMods = () => {
  const { safe } = useSafeInfo()
  const isFeatureEnabled = useHasFeature(FEATURES.ZODIAC_ROLES)

  const [data] = useAsync(async () => {
    if (!ROLES_V2_SUPPORTED_CHAINS.includes(safe.chainId) || !isFeatureEnabled) return []

    const safeModules = safe.modules || []
    const rolesMods = await Promise.all(
      safeModules.map((address) =>
        fetchRolesMod({ address: address.value as `0x${string}`, chainId: parseInt(safe.chainId) as ChainId }),
      ),
    )

    return rolesMods.filter(
      (mod): mod is Exclude<typeof mod, null> =>
        mod !== null &&
        mod.target === safe.address.value.toLowerCase() &&
        mod.avatar === safe.address.value.toLowerCase() &&
        mod.roles.length > 0,
    )
  }, [safe, isFeatureEnabled])

  return data
}

/**
 * Returns a list of roles mod address + role key assigned to the connected wallet.
 * For each role, checks if the role allows the given meta transaction and returns the status.
 */
export const useRoles = (metaTransactions: MetaTransactionData[]) => {
  const rolesMods = useRolesMods()
  const wallet = useWallet()
  const walletAddress = wallet?.address.toLowerCase() as undefined | `0x${string}`

  // find all roles assigned to the connected wallet, statically check if they allow the given meta transaction
  const potentialRoles = useMemo(() => {
    const result: {
      modAddress: `0x${string}`
      roleKey: `0x${string}`
      status: Status | null
    }[] = []

    if (walletAddress && rolesMods) {
      for (const rolesMod of rolesMods) {
        for (const role of rolesMod.roles) {
          if (role.members.includes(walletAddress)) {
            const statuses = metaTransactions.map((metaTx) => checkPermissions(role, metaTx))
            result.push({
              modAddress: rolesMod.address,
              roleKey: role.key,
              status:
                statuses.find((status) => status !== Status.Ok && status !== null) ||
                statuses.find((status) => status !== Status.Ok) ||
                Status.Ok,
            })
          }
        }
      }
    }

    return result
  }, [rolesMods, walletAddress, metaTransactions])
  const web3ReadOnly = useWeb3ReadOnly()

  // if the static check is inconclusive (status: null), evaluate the condition through a test call
  const [dynamicallyCheckedPotentialRoles] = useAsync(
    () =>
      Promise.all(
        potentialRoles.map(async (entry) => {
          if (entry.status === null && walletAddress && web3ReadOnly) {
            entry.status = await checkCondition(
              entry.modAddress,
              entry.roleKey,
              metaTransactions,
              walletAddress,
              web3ReadOnly,
            )
          }
          return entry
        }),
      ),
    [potentialRoles, metaTransactions, walletAddress, web3ReadOnly],
  )

  // Return the statically checked roles while the dynamic checks are still pending
  return dynamicallyCheckedPotentialRoles || potentialRoles
}

/**
 * Returns the status of the permission check, `null` if it depends on the condition evaluation.
 */
const checkPermissions = (role: RoleSummary, metaTx: MetaTransactionData): Status | null => {
  const target = role.targets.find((t) => t.address === metaTx.to.toLowerCase())
  if (!target) return Status.TargetAddressNotAllowed

  if (target.clearance === Clearance.Target) {
    // all calls to the target are allowed
    return checkExecutionOptions(target.executionOptions, metaTx)
  }

  if (target.clearance === Clearance.Function) {
    // check if the function is allowed
    const selector = metaTx.data.slice(0, 10) as `0x${string}`
    const func = target.functions.find((f) => f.selector === selector)
    if (func) {
      const execOptionsStatus = checkExecutionOptions(func.executionOptions, metaTx)
      if (execOptionsStatus !== Status.Ok) return execOptionsStatus
      return func.wildcarded ? Status.Ok : null // wildcarded means there's no condition set
    }
  }

  return Status.FunctionNotAllowed
}

const checkExecutionOptions = (execOptions: ExecutionOptions, metaTx: MetaTransactionData): Status => {
  const isSend = BigInt(metaTx.value || '0') > 0n
  const isDelegateCall = metaTx.operation === OperationType.DelegateCall

  if (isSend && execOptions !== ExecutionOptions.Send && execOptions !== ExecutionOptions.Both) {
    return Status.SendNotAllowed
  }
  if (isDelegateCall && execOptions !== ExecutionOptions.DelegateCall && execOptions !== ExecutionOptions.Both) {
    return Status.DelegateCallNotAllowed
  }

  return Status.Ok
}

export const useExecuteThroughRole = ({
  modAddress,
  roleKey,
  metaTransactions,
}: {
  modAddress?: `0x${string}`
  roleKey?: `0x${string}`
  metaTransactions: MetaTransactionData[]
}) => {
  const web3ReadOnly = useWeb3ReadOnly()
  const wallet = useWallet()
  const walletAddress = wallet?.address.toLowerCase() as undefined | `0x${string}`

  return useMemo(
    () =>
      modAddress && roleKey && walletAddress && web3ReadOnly
        ? encodeExecuteThroughRole(modAddress, roleKey, metaTransactions, walletAddress, web3ReadOnly)
        : undefined,
    [modAddress, roleKey, metaTransactions, walletAddress, web3ReadOnly],
  )
}

// These are the multisend addresses that are used as default in the setup of the Roles Modifier.
// Using them consistently for batch calls made through roles will ensure that the Roles Modifier can handle them.
const MULTISEND_141 = '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526'
const MULTISEND_CALL_ONLY_141 = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'

const encodeMetaTransactions = (metaTransactions: MetaTransactionData[]): MetaTransactionData => {
  if (metaTransactions.length === 0) {
    throw new Error('No meta transactions to encode')
  }
  if (metaTransactions.length === 1) {
    return metaTransactions[0]
  } else {
    return {
      to: metaTransactions.some((metaTx) => metaTx.operation === OperationType.DelegateCall)
        ? MULTISEND_141
        : MULTISEND_CALL_ONLY_141,
      value: '0',
      data: multiSendInterface.encodeFunctionData('multiSend', [encodeMultiSendData(metaTransactions)]),
      operation: OperationType.DelegateCall,
    }
  }
}

const encodeExecuteThroughRole = (
  modAddress: `0x${string}`,
  roleKey: `0x${string}`,
  metaTransactions: MetaTransactionData[],
  from: `0x${string}`,
  provider: JsonRpcProvider,
): Transaction => {
  const rolesModifier = getModuleInstance(KnownContracts.ROLES_V2, modAddress, provider)
  const combinedMetaTx = encodeMetaTransactions(metaTransactions)
  const data = rolesModifier.interface.encodeFunctionData('execTransactionWithRole', [
    combinedMetaTx.to,
    BigInt(combinedMetaTx.value),
    combinedMetaTx.data,
    combinedMetaTx.operation || 0,
    roleKey,
    true,
  ])

  return {
    to: modAddress,
    data,
    value: '0',
    from,
  }
}

const checkCondition = async (
  modAddress: `0x${string}`,
  roleKey: `0x${string}`,
  metaTransactions: MetaTransactionData[],
  from: `0x${string}`,
  provider: JsonRpcProvider,
) => {
  const rolesModifier = getModuleInstance(KnownContracts.ROLES_V2, modAddress, provider)
  const combinedMetaTx = encodeMetaTransactions(metaTransactions)
  try {
    await rolesModifier.execTransactionWithRole.estimateGas(
      combinedMetaTx.to,
      BigInt(combinedMetaTx.value),
      combinedMetaTx.data,
      combinedMetaTx.operation || 0,
      roleKey,
      false,
      { from },
    )

    return Status.Ok
  } catch (e: any) {
    const error = rolesModifier.interface.getError(e.data.slice(0, 10))
    if (error === null || error.name !== 'ConditionViolation') {
      console.error('Unexpected error in condition check', error, e.data, e)
      return null
    }

    // status is a BigInt, convert it to enum
    const { status } = rolesModifier.interface.decodeErrorResult(error, e.data)
    return Number(status) as Status
  }
}

export const useGasLimit = (
  tx?: Transaction,
): {
  gasLimit?: bigint
  gasLimitError?: Error
  gasLimitLoading: boolean
} => {
  const web3ReadOnly = useWeb3ReadOnly()

  const [gasLimit, gasLimitError, gasLimitLoading] = useAsync<bigint | undefined>(async () => {
    if (!web3ReadOnly || !tx) return

    return web3ReadOnly.estimateGas(tx)
  }, [web3ReadOnly, tx])

  useEffect(() => {
    if (gasLimitError) {
      logError(Errors._612, gasLimitError.message)
    }
  }, [gasLimitError])

  return { gasLimit, gasLimitError, gasLimitLoading }
}

export const pollModuleTransactionId = async (props: {
  transactionService: string
  safeAddress: string
  txHash: string
}): Promise<string> => {
  // exponential delay between attempts for around 4 min
  return backOff(() => getModuleTransactionId(props), {
    startingDelay: 750,
    maxDelay: 20000,
    numOfAttempts: 19,
    retry: (e: any) => {
      console.info('waiting for transaction-service to index the module transaction', e)
      return true
    },
  })
}
