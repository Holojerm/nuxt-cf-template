// Registers the files layer's contributions to core (account deletion sweeps
// uploads; the nightly purge collects abandoned ones). Plugins run once per
// isolate before any request, cron or queue batch.
import { registerFilesExtensions } from '../utils/files-extensions'

export default defineNitroPlugin(() => {
  registerFilesExtensions()
})
