(function (global) {
  'use strict';

  function toNumber(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    var normalized = String(value)
      .replace(/\s+/g, '')
      .replace(/\./g, '')
      .replace(',', '.')
      .replace(/[^\d.-]/g, '');

    if (!normalized || normalized === '-' || normalized === '.' || normalized === '-.') {
      return null;
    }

    var parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function format(value, options) {
    var parsed = toNumber(value);
    if (parsed === null) {
      return '';
    }

    var settings = Object.assign(
      {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      },
      options || {}
    );

    return parsed.toLocaleString('id-ID', settings);
  }

  function normalizeInput(value, options) {
    var cleaned = String(value || '').replace(/[^\d,]/g, '');
    var hasComma = cleaned.includes(',');
    var parts = cleaned.split(',');
    var intPart = parts.shift() || '';
    var decPart = parts.join('');
    var maxDecimals = options && typeof options.maxDecimals === 'number' ? options.maxDecimals : 2;

    if (maxDecimals >= 0) {
      decPart = decPart.slice(0, maxDecimals);
    }

    intPart = intPart.replace(/^0+(?=\d)/, '');
    if (!intPart) {
      intPart = '0';
    }

    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

    if (!hasComma) {
      return intPart;
    }

    return intPart + ',' + decPart;
  }

  function parse(value) {
    return toNumber(value);
  }

  global.AppMoney = {
    parse: parse,
    format: format,
    normalizeInput: normalizeInput
  };
})(window);
