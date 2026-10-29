import { useState } from 'react'
import { shareAssetUrl } from '../api/client'
import { allowedExternalImage } from './AuthenticatedImage'

/** 分享页图片：私有图片走签名直链，外链图片仍按 HTTPS 白名单放行 */
export function ShareImage({
  src = '',
  alt = '',
  title,
}: {
  src?: string
  alt?: string
  title?: string
}) {
  const [error, setError] = useState('')
  const signed = shareAssetUrl(src)
  const url = signed ?? (allowedExternalImage(src) ? src : null)

  if (!url || error) {
    return (
      <span className="kh-image-fallback" role="status">
        {alt ? `${alt}：` : ''}
        {error || '图片地址不受支持'}
      </span>
    )
  }

  return (
    <img
      src={url}
      alt={alt}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setError('图片加载失败或分享已失效')}
    />
  )
}
