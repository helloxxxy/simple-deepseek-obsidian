const {createHash} = require('node:crypto');
const {imageMime} = require('./vision');

const imageFormats = Object.freeze({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'});

function imagePayload(value) {
  if (Array.isArray(value)) {
    if (!value.every(part => typeof part === 'string')) return '';
    value = value.join('');
  }
  return typeof value === 'string' ? value.replace(/\s/g,'') : '';
}

function outputFigures(outputs) {
  const figures = [];
  if (!Array.isArray(outputs)) return figures;
  for (const [outputIndex,output] of outputs.entries()) {
    if (!['display_data','execute_result'].includes(output?.output_type)) continue;
    for (const mime of Object.keys(imageFormats)) {
      const encoded = imagePayload(output.data?.[mime]);
      if (!encoded || encoded.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(encoded)) continue;
      const padding = encoded.indexOf('=');
      if (padding >= 0 && (encoded.length%4 || !/^={1,2}$/.test(encoded.slice(padding)))) continue;
      const header = Buffer.from(encoded.slice(0,40),'base64');
      try { if (imageMime(header) !== mime) continue; } catch { continue; }
      const digest = createHash('sha256').update(encoded,'base64').digest('hex');
      figures.push({outputIndex,mime,digest});
      break; // The MIME bundle contains alternate renderings of the same output.
    }
  }
  return figures;
}

function figureFile(notebook, cellIndex, figure) {
  const encoded = imagePayload(notebook.cells[cellIndex].outputs[figure.outputIndex].data[figure.mime]);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return {
    name:'notebook-'+figure.digest+'.'+imageFormats[figure.mime],
    size:Math.floor(encoded.length*3/4)-padding,
    arrayBuffer:async () => Buffer.from(encoded,'base64')
  };
}

module.exports = {outputFigures,figureFile};
