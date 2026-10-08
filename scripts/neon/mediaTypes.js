const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  htm: 'text/html', html: 'text/html', mht: 'message/rfc822', txt: 'text/plain'
};

const DISPLAYABLE = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp']);

export function extOf(fileName) {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

export function contentTypeFor(fileName) {
  return TYPES[extOf(fileName)] ?? 'application/octet-stream';
}

export function isDisplayable(fileName) {
  return DISPLAYABLE.has(extOf(fileName));
}

export function contentDisposition(fileName) {
  const mode = isDisplayable(fileName) ? 'inline' : 'attachment';
  return `${mode}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function objectKeyFor(sha256, fileName) {
  const ext = extOf(fileName);
  return `originals/${sha256}${ext ? `.${ext}` : ''}`;
}
