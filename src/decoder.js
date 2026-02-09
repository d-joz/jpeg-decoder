import { chunk } from "jsr:@std/collections";

export class Decoder {
  constructor() {
    this.quantizationTables = {};
    this.huffanTables = { DC: {}, AC: {} };
    this.componentInfo = {};
    this.imageInfo = {};
    this.unUsedHeaders = {};
    this.mcuStructure = [];
    this.MCU = [];
    this.index;
    this.bitIndex = 0;
  }
  #markers = {
    0xd8: "start of file",
    0xdb: () => this.#processDQT(),
    0xc0: () => this.#processSOF0(),
    0xc4: () => this.#processDHT(),
    0xda: () => this.#processSOS(),
    // 0xd9: " end of file",
    0x00: () => {},
  };
  #toHex(bytes) {
    return bytes.map((byte) => byte.toString(16).padStart(2, "0"));
  }
  #getTwoBytes(bytes) {
    return [bytes.shift(), bytes.shift()];
  }
  #toDec(bytes) {
    return parseInt(bytes.map((byte) => byte.toString(16)).join(""), 16);
  }
  #toNibbles(byte) {
    return [byte >> 4, byte & 0xf];
  }

  #processDQT() {
    console.log(" - processing: DQT");
    const lengthBytes = this.#getTwoBytes(this.image);
    const length = this.#toDec(lengthBytes);
    const [chunkSize, tableId] = this.#toNibbles(this.image.shift());
    this.quantizationTables[tableId] = chunkSize === 0
      ? this.image.splice(0, length - 3)
      : chunk(this.image.splice(0, length - 3), 2)
        .map((chunk) => this.#toDec(chunk));
  }

  #procesComponentInfoSOF0(info, count) {
    if (info.length !== 3 * count) {
      throw new Error("sof0: component info miss match");
    }
    chunk(info, 3).forEach((component) => {
      const [id, samplingFactor, quantizationTableId] = component;
      const [
        horizontalSampling,
        verticalSampling,
      ] = this.#toNibbles(samplingFactor);
      this.componentInfo[id] = {
        horizontalSampling,
        verticalSampling,
        quantizationTableId,
      };
    });
  }
  #processSOF0() {
    console.log(" - processing: SOF0");
    const lengthBytes = this.#getTwoBytes(this.image);
    const length = this.#toDec(lengthBytes);
    const sof0 = this.image.splice(0, length - 2);
    const _precesion = sof0.shift();
    this.imageInfo.height = this.#toDec(this.#getTwoBytes(sof0));
    this.imageInfo.width = this.#toDec(this.#getTwoBytes(sof0));
    const componentCount = sof0.shift();
    this.#procesComponentInfoSOF0(sof0, componentCount);
  }

  #destructureCodes(codeCounts) {
    const codes = [];
    let code = 0;
    codeCounts.forEach((count, index) => {
      for (let i = 0; i < count; i++) {
        codes.push((code++).toString(2).padStart(index + 1, "0"));
      }
      code <<= 1;
    });
    return codes;
  }
  #destructueSymbols(symbols) {
    return symbols.map((symbol) => {
      const [leadingZeros, coeffLength] = this.#toNibbles(symbol);
      return { leadingZeros, coeffLength };
    });
  }
  #mapCodesToSymbols(codes, symbols) {
    return codes
      .reduce((map, code, index) => {
        map[code] = symbols[index];
        return map;
      }, {});
  }
  #processDHT() {
    console.log(" - processing: DHT");
    const lengthBytes = this.#getTwoBytes(this.image);
    const length = this.#toDec(lengthBytes);
    const dht = this.image.splice(0, length - 2);
    const [tableTypeBit, tableId] = this.#toNibbles(dht.shift());
    const tableType = tableTypeBit === 0 ? "DC" : "AC";
    const codes = this.#destructureCodes(dht.splice(0, 16));
    const symbols = tableTypeBit === 1 ? this.#destructueSymbols(dht) : dht;
    this.huffanTables[tableType][tableId] = this.#mapCodesToSymbols(
      codes,
      symbols,
    );
  }

  #procesComponentInfoSOS(info, count) {
    if (info.length !== 2 * count) {
      throw new Error("sos: component info miss match");
    }
    chunk(info, 2).forEach((component) => {
      const [id, huffmanTableIds] = component;
      const [
        idDC,
        idAC,
      ] = this.#toNibbles(huffmanTableIds);
      this.componentInfo[id].idDC = idDC;
      this.componentInfo[id].idAC = idAC;
    });
  }
  #processSOS() {
    console.log(" - processing: SOS");
    const lengthBytes = this.#getTwoBytes(this.image);
    const length = this.#toDec(lengthBytes);
    const sos = this.image.splice(0, length - 2);
    const componentCount = sos.shift();
    const componentInfo = sos.splice(0, componentCount * 2);
    this.#procesComponentInfoSOS(componentInfo, componentCount);
  }

  #isEssentialMarker([_, marker]) {
    return marker in this.#markers;
  }
  #skipHeader(marker) {
    console.log(` - skiping: ${this.#toHex(marker)}`);
    const unUsedHeader = [];
    while (true) {
      if (this.image[0] === 0xff) {
        this.unUsedHeaders[this.#toHex(marker)] = unUsedHeader;
        return;
      }
      unUsedHeader.push(this.image.shift());
    }
  }
  #validateMarker([start, marker]) {
    if (start !== 0xff) throw new Error(`invalid marker: ${[start, marker]}`);
  }
  #validateSOI() {
    if (!(this.image.shift() === 0xff && this.image.shift() === 0xd8)) {
      throw new Error("invalid image: start of image not found");
    }
  }
  #processHeaders() {
    console.log("* processing headers: start");
    this.#validateSOI();
    let done = false;
    while (!done) {
      const marker = this.#getTwoBytes(this.image);
      this.#validateMarker(marker);

      if (this.#isEssentialMarker(marker)) {
        this.#markers[marker[1]]();
      } else {
        this.#skipHeader(marker);
      }
      if (marker[1] === 0xda) done = true;
    }
    console.log("* processing headers: done");
  }

  #setMCUStucture() {
    for (const id in this.componentInfo) {
      const { horizontalSampling, verticalSampling } = this.componentInfo[id];
      const samplingFactor = horizontalSampling * verticalSampling;
      for (let i = 0; i < samplingFactor; i++) {
        this.mcuStructure.push(id);
      }
    }
  }
  #getMCUCount() {
    this.horizontalMCU = Math.ceil(this.imageInfo.width / 8) /
      this.componentInfo[1].horizontalSampling;
    this.verticalMCU = Math.ceil(this.imageInfo.height / 8) /
      this.componentInfo[1].verticalSampling;

    return this.horizontalMCU * this.verticalMCU;
  }
  #getTables(id) {
    const { idAC, idDC, quantizationTableId } = this.componentInfo[id];
    const huffanTableDC = this.huffanTables.DC[idDC];
    const huffanTableAC = this.huffanTables.AC[idAC];
    const quantizationTable = this.quantizationTables[quantizationTableId];
    return { huffanTableDC, huffanTableAC, quantizationTable };
  }
  #validateByteStuffing() {
    if (this.#readByte() !== 0) throw new Error("invalid marker");
  }
  #readByte() {
    return this.image[this.index++];
  }
  #readBit() {
    if (this.bitIndex === 0) {
      this.currentByte = this.#readByte().toString(2).padStart(8, "0");
      if (this.currentByte === (0xff).toString(2)) this.#validateByteStuffing();
    }
    const bit = this.currentByte[this.bitIndex];
    this.bitIndex = (this.bitIndex + 1) % 8;
    return bit;
  }
  #getCode(table) {
    let code = "";
    while (!(code in table)) {
      code += this.#readBit();
      if (code.length > 16) throw "....";
    }
    return code;
  }
  #parseCoeff(coeff, length) {
    const unsignedCoeff = parseInt(coeff, 2);
    return coeff[0] === "0"
      ? unsignedCoeff - (2 ** (length - 1))
      : unsignedCoeff;
  }
  #getCoeff(length) {
    let coeff = "";
    for (let i = 0; i < length; i++) coeff += this.#readBit();
    return this.#parseCoeff(coeff, length);
  }
  #getDCCoeff(table) {
    const code = this.#getCode(table);
    const coeffLength = table[code];
    return coeffLength > 0 ? this.#getCoeff(coeffLength) : 0;
  }
  #getACCoeffs(table) {
    const ACBlock = [];
    while (ACBlock.length < 63) {
      const code = this.#getCode(table);
      const { leadingZeros, coeffLength } = table[code];
      if (leadingZeros === 0 && coeffLength === 0) {
        ACBlock.push(...Array.from({ length: 63 - ACBlock.length }, () => 0));
        return ACBlock;
      }
      ACBlock.push(...Array.from({ length: leadingZeros }, () => 0));
      ACBlock.push(coeffLength > 0 ? this.#getCoeff(coeffLength) : 0);
    }
    return ACBlock;
  }
  #huffmanDecode(DCTable, ACTable) {
    const block = [];
    block.push(this.#getDCCoeff(DCTable));
    block.push(...this.#getACCoeffs(ACTable));
    return block;
  }
  #processComponentBlock(id) {
    const {
      huffanTableDC,
      huffanTableAC,
      quantizationTable,
    } = this.#getTables(id);
    return this.#huffmanDecode(huffanTableDC, huffanTableAC);
  }
  #processMCU() {
    const MCU = [];
    for (let i = 0; i < this.mcuStructure.length; i++) {
      MCU.push(this.#processComponentBlock(this.mcuStructure[i]));
    }
    return MCU;
  }

  #processData() {
    console.log("* processing data bits: start");
    this.#setMCUStucture();
    const MCUCount = this.#getMCUCount();
    this.index = 0;
    for (let i = 0; i < MCUCount; i++) {
      this.MCU.push(this.#processMCU());
    }
    console.log("* processing data bits: done");
  }

  async decode(path) {
    try {
      console.log(`reading file: ${path}`);
      this.image = [...await Deno.readFile(path)];
      this.#processHeaders();
      this.#processData();
    } catch (error) {
      console.log(error.message);
      // console.log(error);
    }
  }
}
