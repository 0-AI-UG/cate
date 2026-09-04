import { useRef } from 'react'
import { Image as ImageIcon, X } from '@phosphor-icons/react'
import type { CodingImageAttachment } from '../../shared/types'
import { IconButton } from '../ui/Button'
import { readFileAsImage } from './imageAttachments'

export function ImageChips({
  images,
  onRemove,
}: {
  images: CodingImageAttachment[]
  onRemove: (index: number) => void
}) {
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {images.map((image, index) => (
        <div
          key={index}
          className="flex items-center gap-1 rounded-md bg-agent/15 py-0.5 pl-1 pr-1.5 text-[10px] text-primary"
        >
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt=""
            className="h-5 w-5 rounded object-cover"
          />
          <span className="max-w-[140px] truncate">{image.fileName ?? 'image'}</span>
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="ml-0.5 opacity-70 hover:opacity-100"
            aria-label={`Remove ${image.fileName ?? 'image'}`}
          >
            <X size={9} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function ImageAttachButton({ onPick }: { onPick: (image: CodingImageAttachment) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={async (event) => {
          const files = event.target.files
          if (!files) return
          for (const file of Array.from(files)) {
            const image = await readFileAsImage(file)
            if (image) onPick(image)
          }
          event.currentTarget.value = ''
        }}
      />
      <IconButton
        label="Attach image"
        tooltipPlacement="top"
        size={28}
        onClick={() => inputRef.current?.click()}
      >
        <ImageIcon size={13} />
      </IconButton>
    </>
  )
}
