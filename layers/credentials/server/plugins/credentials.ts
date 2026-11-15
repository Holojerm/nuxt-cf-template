// Registers the credentials layer's contributions to core (account deletion and
// export, the nightly token sweep). Plugins run once per isolate before any
// request, cron or queue batch.
import { registerCredentialsExtensions } from '../utils/credentials-extensions'

export default defineNitroPlugin(() => {
  registerCredentialsExtensions()
})
