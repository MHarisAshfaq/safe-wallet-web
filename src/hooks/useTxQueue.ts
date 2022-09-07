import { getTransactionQueue, type TransactionListPage } from '@gnosis.pm/safe-react-gateway-sdk'
import { useAppSelector } from '@/store'
import useAsync from './useAsync'
import { selectTxQueue, selectQueuedTransactionsByNonce } from '@/store/txQueueSlice'
import useSafeInfo from './useSafeInfo'
import { localizeTxListDateLabelTimezone } from '@/utils/transactions'
import { useMemo } from 'react'

const useTxQueue = (
  pageUrl?: string,
): {
  page?: TransactionListPage
  error?: string
  loading: boolean
} => {
  const { safe, safeAddress, safeLoaded } = useSafeInfo()
  const { chainId } = safe

  // If pageUrl is passed, load a new queue page from the API
  const [page, error, loading] = useAsync<TransactionListPage>(() => {
    if (!pageUrl || !safeLoaded) return
    return getTransactionQueue(chainId, safeAddress, pageUrl)
  }, [chainId, safeAddress, safeLoaded, pageUrl])

  // The latest page of the queue is always in the store
  const queueState = useAppSelector(selectTxQueue)

  // Return the new page or the stored page
  return useMemo(() => {
    const txQueue = pageUrl
      ? {
          page,
          error: error?.message,
          loading: loading,
        }
      : {
          page: queueState.data,
          error: queueState.error,
          loading: queueState.loading,
        }

    return {
      ...txQueue,
      page: localizeTxListDateLabelTimezone(txQueue.page),
    }
  }, [error?.message, loading, page, pageUrl, queueState.data, queueState.error, queueState.loading])
}

export const useQueuedTxByNonce = (nonce?: number) => {
  return useAppSelector((state) => selectQueuedTransactionsByNonce(state, nonce))
}

export default useTxQueue
