// Image checks and resizing shared by photo and screenshot recognition.
// Everything happens in browser memory; nothing is stored.

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MIN_SIDE = 200;
export const MAX_SIDE = 16_384;
/** Long edge sent for recognition, the size Claude's vision works best at. */
export const UPLOAD_LONG_EDGE = 1568;

/** A readable reason the file cannot be used, or null when it can. */
export function fileProblem(file: File): string | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return 'Use a PNG, JPEG, or WebP image.';
  if (file.size > MAX_FILE_BYTES) return 'The image is larger than 12 MB.';
  if (file.size === 0) return 'The image is empty.';
  return null;
}

/** Decode with the photo's orientation applied, and check its dimensions. */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image could not be opened.');
  }
  const { width, height } = bitmap;
  if (Math.min(width, height) < MIN_SIDE) {
    bitmap.close();
    throw new Error('The image is too small (' + width + '×' + height + '); use one at least ' + MIN_SIDE + ' pixels on each side.');
  }
  if (Math.max(width, height) > MAX_SIDE) {
    bitmap.close();
    throw new Error('The image is too large (' + width + '×' + height + ').');
  }
  return bitmap;
}

/** Downscale to the recognition size and re-encode as JPEG, which drops metadata. */
export async function prepareUpload(image: Blob | ImageBitmap): Promise<Blob> {
  const bitmap = image instanceof Blob ? await createImageBitmap(image, { imageOrientation: 'from-image' }) : image;
  const scale = Math.min(1, UPLOAD_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  if (image instanceof Blob) bitmap.close();
  try {
    return await new Promise((resolve, reject) => canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Could not prepare the image.'))), 'image/jpeg', 0.9,
    ));
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Render an SVG document to a PNG file, for the built-in sample screenshots. */
export async function svgToPng(svg: string, name: string): Promise<File> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The sample could not be drawn.'));
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || 960;
    canvas.height = image.naturalHeight || 600;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The sample could not be drawn.'))), 'image/png'));
    return new File([blob], name, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
