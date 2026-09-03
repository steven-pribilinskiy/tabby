import { LinkFileTypeGroup } from './api'

/**
 * The extension lists a rule's "File type" criterion matches against. Kept
 * identical to `HyperlinkFileTypeGroups.h` in the Windows Terminal fork so a
 * rule means the same thing in both apps.
 */
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']
const VIDEO = ['mp4', 'mkv', 'webm', 'mov', 'avi']
const AUDIO = ['mp3', 'wav', 'flac', 'ogg', 'm4a']

export const FILE_TYPE_GROUPS: Record<LinkFileTypeGroup, string[]> = {
    none: [],
    image: IMAGE,
    video: VIDEO,
    audio: AUDIO,
    media: [...IMAGE, ...VIDEO, ...AUDIO],
    sourceCode: ['cs', 'cpp', 'h', 'hpp', 'c', 'py', 'js', 'ts', 'rs', 'go', 'java', 'rb', 'ps1', 'sh'],
    document: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md'],
    archive: ['zip', '7z', 'rar', 'tar', 'gz'],
    executable: ['exe', 'msi', 'bat', 'cmd', 'ps1'],
}

export const FILE_TYPE_GROUP_LABELS: { value: LinkFileTypeGroup, label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'image', label: 'Image' },
    { value: 'video', label: 'Video' },
    { value: 'audio', label: 'Audio' },
    { value: 'media', label: 'Media (image, video, or audio)' },
    { value: 'sourceCode', label: 'Source code' },
    { value: 'document', label: 'Document' },
    { value: 'archive', label: 'Archive' },
    { value: 'executable', label: 'Executable' },
]

/**
 * The extension of a path or URI, lowercased and without the dot. Empty when
 * the last segment has none — note that the dot must come *after* the last
 * separator, or `/home/user.name/README` would report `name/README`.
 */
export function extensionOf (target: string): string {
    const withoutQuery = target.split(/[?#]/)[0]
    const lastSep = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'))
    const lastDot = withoutQuery.lastIndexOf('.')
    if (lastDot <= lastSep + 1) {
        return ''
    }
    return withoutQuery.substring(lastDot + 1).toLowerCase()
}

export function matchesFileType (
    target: string,
    group: LinkFileTypeGroup,
    customExtensions: string[],
): boolean {
    const extension = extensionOf(target)
    if (!extension) {
        return false
    }
    const groupExtensions = FILE_TYPE_GROUPS[group]
    const custom = customExtensions.map(x => x.trim().replace(/^\./, '').toLowerCase()).filter(x => x)
    return groupExtensions.includes(extension) || custom.includes(extension)
}
