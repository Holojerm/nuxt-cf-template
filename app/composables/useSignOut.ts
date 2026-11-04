/** Ends the session and returns to the landing page; toasts if the server call fails. */
export function useSignOut() {
  const { clear: clearSession } = useUserSession()

  const { pending, run } = useAsyncAction(
    async () => {
      await $fetch('/api/auth/logout', { method: 'POST' })
      await clearSession()
      await navigateTo('/')
    },
    { errorTitle: 'Could not sign out' },
  )

  return { signOut: run, pending }
}
