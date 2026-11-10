/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Game analytics in PostHog: join, leave (with session length, kills and deaths), room_full and a
 * room-size sample once a minute. Cookieless (nothing kept in the browser, so no consent banner) and
 * keyed by the random player id; names are not sent. Off on localhost, so dev and bot runs don't count.
 */
const enabled =
  !['localhost', '127.0.0.1'].includes(location.hostname) && !/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)

/** `leave` goes as a beacon, which survives the page closing. PostHog loads in the background after joining (it is larger than the game); events wait for it. */
export function startAnalytics(player: string) {
  const ready = enabled
    ? import('posthog-js').then(({ default: posthog }) => {
        posthog.init('phc_xTQg4iNbCIrPiQVyr4CFjsaC0fWAo2rfNs5xeyu1GTG', {
          api_host: 'https://us.i.posthog.com',
          persistence: 'memory', // cookieless
          autocapture: false,
          capture_pageview: false,
          disable_session_recording: true,
        })
        posthog.identify(player)
        return posthog
      })
    : undefined
  return {
    track: (event: string, props?: Record<string, unknown>) =>
      void ready
        ?.then((posthog) => posthog.capture(event, props, event === 'leave' ? { transport: 'sendBeacon' } : undefined))
        .catch(() => {}),
  }
}
