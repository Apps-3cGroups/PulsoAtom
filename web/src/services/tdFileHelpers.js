const result = (success, message, data = null, error = null) => ({ success, message, data, error });

export function fileToBase64(file) {
  return new Promise(resolve => {
    if (!(file instanceof Blob)) return resolve(result(false, 'Selecciona un archivo válido.', null, { code: 'INVALID_FILE' }));
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(result(true, 'Archivo convertido a base64.', String(reader.result).split(',')[1] || ''));
      reader.onerror = () => resolve(result(false, 'No se pudo leer el archivo.', null, { code: 'FILE_READ_FAILED' }));
      reader.readAsDataURL(file);
    } catch { resolve(result(false, 'No se pudo leer el archivo.', null, { code: 'FILE_READ_FAILED' })); }
  });
}

export function downloadBlob(blob, fileName) {
  if (!(blob instanceof Blob) || typeof fileName !== 'string' || !fileName.trim()) return result(false, 'Indica un archivo y un nombre válidos.', null, { code: 'INVALID_DOWNLOAD' });
  let objectUrl;
  try {
    objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName.replace(/[\\/\x00-\x1f]/g, '_');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    return result(true, 'Descarga iniciada.', { fileName: link.download });
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return result(false, 'No se pudo iniciar la descarga.', null, { code: 'DOWNLOAD_FAILED' });
  }
}
