export function waterfallPixelFrequency({ center, span, x, cssWidth, backingWidth, pixelRatio, leftInset = 43, rightInset = 12 }) {
  if (![center, span, x, cssWidth, backingWidth, pixelRatio, leftInset, rightInset].every(Number.isFinite)
    || span <= 0 || cssWidth <= 0 || x < 0 || x >= cssWidth || backingWidth <= 0 || pixelRatio <= 0) return null;

  const plotLeft = Math.floor(leftInset * pixelRatio);
  const plotRight = backingWidth - Math.floor(rightInset * pixelRatio);
  const plotWidth = plotRight - plotLeft;
  const pixel = Math.floor(x * pixelRatio);
  if (plotWidth <= 0 || pixel < plotLeft || pixel >= plotRight) return null;

  const fraction = (pixel + 0.5 - plotLeft) / plotWidth;
  return Math.round(center - span / 2 + fraction * span);
}

export function snapWaterfallFrequency(frequency, step) {
  if (!Number.isFinite(frequency) || !Number.isFinite(step) || step <= 0) return null;
  return Math.round(frequency / step) * step;
}
