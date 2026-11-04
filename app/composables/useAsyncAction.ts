export interface AsyncActionOptions {
  errorTitle: string
  successTitle?: string
}

/**
 * Pending flag plus a runner that toasts on failure, for button handlers.
 * `run` resolves true on success and false after toasting, so callers can
 * continue (or not) without their own try/catch.
 */
export function useAsyncAction<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
  { errorTitle, successTitle }: AsyncActionOptions,
) {
  const toast = useToast()
  const pending = ref(false)

  async function run(...args: A): Promise<boolean> {
    pending.value = true
    try {
      await fn(...args)
      if (successTitle) toast.add({ title: successTitle, color: 'success' })
      return true
    } catch (error) {
      toast.add({
        title: errorTitle,
        description: apiErrorMessage(error, 'Try again in a moment.'),
        color: 'error',
      })
      return false
    } finally {
      pending.value = false
    }
  }

  return { pending, run }
}
