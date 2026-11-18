// Which devices get "Share, then Add to Home Screen" where others get a prompt.

import { describe, expect, it } from 'vitest'

import { isIosDevice } from '../app/utils/pwa-platform'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1'
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

describe('isIosDevice', () => {
  it('is true on an iPhone, in Safari or any other browser', () => {
    expect(isIosDevice({ userAgent: IPHONE })).toBe(true)
    expect(isIosDevice({ userAgent: IPHONE_CHROME })).toBe(true)
  })

  it('is true on an iPad, which says it is a Mac but has a touch screen', () => {
    expect(isIosDevice({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      true,
    )
  })

  it('is false on a real Mac and on Android', () => {
    expect(isIosDevice({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      false,
    )
    expect(isIosDevice({ userAgent: ANDROID, platform: 'Linux armv81', maxTouchPoints: 5 })).toBe(
      false,
    )
  })
})
