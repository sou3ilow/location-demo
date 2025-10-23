"use strict";

const photoInput = document.getElementById("photoInput");
const analyzeButton = document.getElementById("analyzeButton");
const resultsList = document.getElementById("results");
const statusMessage = document.getElementById("statusMessage");
const fileInputLabel = document.getElementById("fileInputLabel");
const fileInputWrapper = document.querySelector(".file-input");
const appVersionSpan = document.getElementById("appVersion");

const APP_VERSION = "1.1.0";

if (appVersionSpan) {
  appVersionSpan.textContent = APP_VERSION;
}

const defaultView = [35.6762, 139.6503];
const defaultZoom = 5;

const map = L.map("map", {
  zoomControl: true,
  attributionControl: true,
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

map.setView(defaultView, defaultZoom);

const markerLayer = L.layerGroup().addTo(map);

photoInput.addEventListener("change", handleFileSelectionChange);
analyzeButton.addEventListener("click", handleAnalyze);

async function handleAnalyze() {
  const files = Array.from(photoInput.files || []);

  if (!files.length) {
    statusMessage.textContent = "画像ファイルを選択してください。";
    return;
  }

  analyzeButton.disabled = true;
  statusMessage.textContent = "解析中です…";
  resultsList.innerHTML = "";
  markerLayer.clearLayers();
  map.setView(defaultView, defaultZoom);

  const foundCoordinates = [];

  for (const file of files) {
    const { listItem, messageSpan } = createResultItem(file.name);
    resultsList.appendChild(listItem);

    try {
      const formatWarning = validateFileFormat(file);

      if (formatWarning) {
        messageSpan.textContent = formatWarning;
        messageSpan.classList.add("result-error");
        continue;
      }

      const coordinates = await extractGpsFromFile(file);

      if (!coordinates) {
        throw new Error("位置情報は見つかりませんでした。");
      }

      const lat = coordinates.lat;
      const lng = coordinates.lng;
      const formatted = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

      messageSpan.textContent = `位置情報: ${formatted}`;
      messageSpan.classList.add("result-success");

      const marker = L.marker([lat, lng], { title: file.name });
      marker.bindPopup(
        `<strong>${escapeHtml(file.name)}</strong><br>${formatted}`
      );
      marker.addTo(markerLayer);

      foundCoordinates.push([lat, lng]);
    } catch (error) {
      messageSpan.textContent =
        error && error.message
          ? error.message
          : "位置情報の解析に失敗しました。";
      messageSpan.classList.add("result-error");
    }
  }

  if (foundCoordinates.length === 1) {
    map.setView(foundCoordinates[0], 14);
    statusMessage.textContent = "解析が完了しました。";
  } else if (foundCoordinates.length > 1) {
    const bounds = L.latLngBounds(foundCoordinates);
    map.fitBounds(bounds, { padding: [30, 30] });
    statusMessage.textContent = "解析が完了しました。";
  } else {
    statusMessage.textContent = "位置情報を含む写真が見つかりませんでした。";
  }

  analyzeButton.disabled = false;
}

function createResultItem(fileName) {
  const listItem = document.createElement("li");
  const labelSpan = document.createElement("span");
  const messageSpan = document.createElement("span");

  labelSpan.className = "result-label";
  labelSpan.textContent = fileName;

  messageSpan.className = "result-message";
  messageSpan.textContent = "解析中…";

  listItem.appendChild(labelSpan);
  listItem.appendChild(messageSpan);

  return { listItem, messageSpan };
}

function validateFileFormat(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();

  const isJpegType = type === "image/jpeg";
  const hasJpegExtension = /\.jpe?g$/.test(name);

  if (isJpegType || hasJpegExtension || isHeicFileType(type, name)) {
    return null;
  }

  return "この形式の写真は解析対象外です。JPEGまたはHEIC形式で撮影してください。";
}

async function extractGpsFromFile(file) {
  const buffer = await file.arrayBuffer();
  const dataView = new DataView(buffer);
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  const isHeic = isHeicFileType(type, name);

  if (!isJpeg(dataView)) {
    if (!isHeic) {
      throw new Error("JPEGまたはHEIC形式の写真に対応しています。");
    }
  }

  if (isHeic) {
    const exifInfo = locateExifSegmentInHeic(dataView);

    if (!exifInfo) {
      throw new Error(
        "位置情報が含まれていないか、共有時に削除された可能性があります。"
      );
    }

    return parseGpsFromTiff(dataView, exifInfo);
  }

  const exifInfo = locateExifSegment(dataView);

  if (!exifInfo) {
    throw new Error("メタ情報が見つかりませんでした。");
  }

  return parseGpsFromTiff(dataView, exifInfo);
}

function isJpeg(dataView) {
  if (dataView.byteLength < 4) {
    return false;
  }

  const soi = dataView.getUint16(0, false);
  return soi === 0xffd8;
}

function locateExifSegment(dataView) {
  let offset = 2;

  while (offset + 4 < dataView.byteLength) {
    if (dataView.getUint8(offset) !== 0xff) {
      break;
    }

    const marker = dataView.getUint8(offset + 1);

    if (marker === 0xda) {
      break;
    }

    const length = dataView.getUint16(offset + 2, false);

    if (marker === 0xe1 && length >= 8) {
      const headerStart = offset + 4;
      const signature = getAscii(dataView, headerStart, 4);

      if (
        signature === "Exif" &&
        dataView.getUint8(headerStart + 4) === 0x00 &&
        dataView.getUint8(headerStart + 5) === 0x00
      ) {
        const tiffOffset = headerStart + 6;
        const byteOrder = getAscii(dataView, tiffOffset, 2);

        if (byteOrder !== "II" && byteOrder !== "MM") {
          return null;
        }

        const littleEndian = byteOrder === "II";
        return { tiffOffset, littleEndian };
      }
    }

    offset += 2 + 2 + length;
  }

  return null;
}

function locateExifSegmentInHeic(dataView) {
  const signature = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const max = dataView.byteLength - signature.length - 2;

  for (let offset = 0; offset <= max; offset += 1) {
    let matched = true;

    for (let index = 0; index < signature.length; index += 1) {
      if (dataView.getUint8(offset + index) !== signature[index]) {
        matched = false;
        break;
      }
    }

    if (!matched) {
      continue;
    }

    const tiffOffset = offset + signature.length;

    if (tiffOffset + 8 > dataView.byteLength) {
      continue;
    }

    const byteOrder = getAscii(dataView, tiffOffset, 2);

    if (byteOrder !== "II" && byteOrder !== "MM") {
      continue;
    }

    const littleEndian = byteOrder === "II";
    return { tiffOffset, littleEndian };
  }

  return null;
}

function parseGpsFromTiff(dataView, { tiffOffset, littleEndian }) {
  if (tiffOffset + 8 > dataView.byteLength) {
    return null;
  }

  const firstIfdOffset = dataView.getUint32(tiffOffset + 4, littleEndian);
  const ifdStart = tiffOffset + firstIfdOffset;

  const firstIfd = readIfdEntries(dataView, ifdStart, littleEndian, tiffOffset);

  if (!firstIfd.entries.has(0x8825)) {
    return null;
  }

  const gpsInfo = firstIfd.entries.get(0x8825);
  const gpsOffset = gpsInfo.valueOrOffset;
  const gpsIfdStart = tiffOffset + gpsOffset;
  const gpsIfd = readIfdEntries(dataView, gpsIfdStart, littleEndian, tiffOffset);

  const latRefEntry = gpsIfd.entries.get(0x0001);
  const latEntry = gpsIfd.entries.get(0x0002);
  const lonRefEntry = gpsIfd.entries.get(0x0003);
  const lonEntry = gpsIfd.entries.get(0x0004);

  if (!latRefEntry || !latEntry || !lonRefEntry || !lonEntry) {
    return null;
  }

  const latRef = readAsciiValue(dataView, latRefEntry);
  const lonRef = readAsciiValue(dataView, lonRefEntry);
  const latValues = readRationalValues(dataView, latEntry, littleEndian);
  const lonValues = readRationalValues(dataView, lonEntry, littleEndian);

  if (!latValues || !lonValues) {
    return null;
  }

  const latitude = convertToDecimalDegrees(latValues, latRef);
  const longitude = convertToDecimalDegrees(lonValues, lonRef);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { lat: latitude, lng: longitude };
}

function readIfdEntries(dataView, offset, littleEndian, baseOffset) {
  const entries = new Map();

  if (offset <= 0 || offset + 2 > dataView.byteLength) {
    return { entries };
  }

  const entryCount = dataView.getUint16(offset, littleEndian);
  let cursor = offset + 2;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 12 > dataView.byteLength) {
      break;
    }

    const tag = dataView.getUint16(cursor, littleEndian);
    const type = dataView.getUint16(cursor + 2, littleEndian);
    const count = dataView.getUint32(cursor + 4, littleEndian);
    const valueOrOffset = dataView.getUint32(cursor + 8, littleEndian);
    const unitSize = getTypeSize(type);

    if (!unitSize) {
      cursor += 12;
      continue;
    }

    const valueSize = unitSize * count;
    let dataOffset = cursor + 8;

    if (valueSize > 4) {
      dataOffset = baseOffset + valueOrOffset;

      if (dataOffset + valueSize > dataView.byteLength) {
        cursor += 12;
        continue;
      }
    }

    entries.set(tag, {
      type,
      count,
      dataOffset,
      valueOrOffset,
      valueSize,
    });

    cursor += 12;
  }

  return { entries };
}

function readAsciiValue(dataView, entry) {
  const bytes = [];
  const end = entry.dataOffset + entry.count;

  for (let pointer = entry.dataOffset; pointer < end; pointer += 1) {
    if (pointer >= dataView.byteLength) {
      break;
    }

    const value = dataView.getUint8(pointer);
    if (value === 0) {
      break;
    }

    bytes.push(value);
  }

  return String.fromCharCode(...bytes);
}

function readRationalValues(dataView, entry, littleEndian) {
  const rationals = [];

  for (let index = 0; index < entry.count; index += 1) {
    const numeratorOffset = entry.dataOffset + index * 8;
    const denominatorOffset = numeratorOffset + 4;

    if (denominatorOffset + 4 > dataView.byteLength) {
      return null;
    }

    const numerator = dataView.getUint32(numeratorOffset, littleEndian);
    const denominator = dataView.getUint32(denominatorOffset, littleEndian);

    if (denominator === 0) {
      return null;
    }

    rationals.push({ numerator, denominator });
  }

  return rationals;
}

function convertToDecimalDegrees(values, ref) {
  if (!values || values.length < 3) {
    return Number.NaN;
  }

  const degrees = values[0].numerator / values[0].denominator;
  const minutes = values[1].numerator / values[1].denominator;
  const seconds = values[2].numerator / values[2].denominator;

  let result = degrees + minutes / 60 + seconds / 3600;
  const refLetter = (ref || "").trim().toUpperCase();

  if (refLetter === "S" || refLetter === "W") {
    result *= -1;
  }

  return result;
}

function handleFileSelectionChange(event) {
  const files = Array.from(event.target.files || []);

  if (files.length) {
    analyzeButton.disabled = false;
    statusMessage.textContent = `${files.length}件の画像が選択されています。`;
    if (fileInputLabel) {
      fileInputLabel.textContent = `${files.length}件の画像を選択中`;
    }
    fileInputWrapper?.classList.add("selected");
  } else {
    analyzeButton.disabled = true;
    statusMessage.textContent = "画像ファイルを選択してください。";
    if (fileInputLabel) {
      fileInputLabel.textContent = "画像ファイルを選択（複数可）";
    }
    fileInputWrapper?.classList.remove("selected");
    resultsList.innerHTML = "";
    markerLayer.clearLayers();
    map.setView(defaultView, defaultZoom);
  }
}

function getTypeSize(type) {
  switch (type) {
    case 1:
    case 2:
    case 7:
      return 1;
    case 3:
      return 2;
    case 4:
    case 9:
      return 4;
    case 5:
    case 10:
      return 8;
    default:
      return 0;
  }
}

function getAscii(dataView, offset, length) {
  if (offset + length > dataView.byteLength) {
    return "";
  }

  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(dataView.getUint8(offset + index));
  }
  return result;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isHeicFileType(type, name) {
  return (
    type.includes("heic") ||
    type.includes("heif") ||
    /\.heic$/.test(name) ||
    /\.heif$/.test(name)
  );
}
