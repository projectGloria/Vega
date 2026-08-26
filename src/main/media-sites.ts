/**
 * Which hosts are worth probing when a link lands on the clipboard.
 *
 * yt-dlp's generic extractor will happily attempt *any* page, so without a
 * list every copied URL — a GitHub repo, a docs page, a Jira ticket — spawns a
 * yt-dlp process that works for several seconds and then fails. The failures
 * pile up in the clipboard list, which is exactly the noise that feature is
 * supposed to avoid.
 *
 * This gate is deliberately only applied to links the app picks up *on its
 * own*. A URL someone pastes and asks to download is left alone: the generic
 * extractor genuinely does pull video out of sites that no list will ever
 * cover, and refusing that would break real downloads to prevent a guess.
 */

/**
 * Registrable domains, matched against the hostname and any subdomain of it.
 * `youtube.com` therefore covers `www.`, `m.` and `music.youtube.com`.
 *
 * Add a host here to have the clipboard watcher start picking it up.
 */
const MEDIA_HOSTS = [
  // Video platforms
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'vimeo.com',
  'dailymotion.com',
  'dai.ly',
  'rumble.com',
  'odysee.com',
  'bitchute.com',
  'streamable.com',
  'coub.com',
  'veoh.com',
  'archive.org',
  'ted.com',
  'newgrounds.com',

  // Live streaming
  'twitch.tv',
  'kick.com',

  // Social
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'twitter.com',
  'x.com',
  'reddit.com',
  'redd.it',
  'snapchat.com',
  'pinterest.com',
  'tumblr.com',
  'linkedin.com',

  // Audio
  'soundcloud.com',
  'bandcamp.com',
  'mixcloud.com',
  'audiomack.com',

  // Regional
  'bilibili.com',
  'b23.tv',
  'nicovideo.jp',
  'vk.com',
  'ok.ru',
  'rutube.ru',
  'youku.com',
  'iqiyi.com',
  'douyin.com',
  'weibo.com',
  'naver.com',
  'afreecatv.com',

  // News and broadcast
  'bbc.co.uk',
  'bbc.com',
  'cnn.com',
  'nbcnews.com',
  'cbsnews.com',
  'abcnews.go.com',
  'aljazeera.com',
  'reuters.com',
  'espn.com',
  'trtizle.com',
  'tabii.com',
  'puhutv.com'
]

/**
 * Hosts that serve a media file directly rather than a page about one. Matched
 * on the path instead of the host, since these come from anywhere.
 */
const MEDIA_EXTENSIONS = [
  '.mp4',
  '.webm',
  '.mkv',
  '.mov',
  '.avi',
  '.flv',
  '.m4v',
  '.mp3',
  '.m4a',
  '.opus',
  '.flac',
  '.wav',
  '.ogg',
  '.m3u8',
  '.mpd'
]

const HOSTS = new Set(MEDIA_HOSTS)

/**
 * True when a URL is worth handing to yt-dlp unprompted.
 *
 * Matching is on the registrable domain rather than a substring: a substring
 * test would accept `youtube.com.phishing.example` as YouTube.
 */
export function isMediaUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase().replace(/^www\./, '')

  if (HOSTS.has(host)) return true
  for (const known of HOSTS) {
    if (host.endsWith('.' + known)) return true
  }

  // A direct link to a media file is unambiguous wherever it is hosted.
  const path = url.pathname.toLowerCase()
  return MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext))
}
