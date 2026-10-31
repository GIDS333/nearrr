/** Ondo tokenized stocks and ETFs, as listed on nearly.trade (traded through NEAR Intents 1Click). */
export interface Stock {
  symbol: string;
  name: string;
  token: string;
}

export const STOCKS: Stock[] = [
  { symbol: "NVDAon", name: "NVIDIA", token: "bnb-0xa9ee28c80f960b889dfbd1902055218cba016f75.omdep.near" },
  { symbol: "TSLAon", name: "Tesla", token: "bnb-0x2494b603319d4d9f9715c9f4496d9e0364b59d93.omdep.near" },
  { symbol: "AAPLon", name: "Apple", token: "bnb-0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4.omdep.near" },
  { symbol: "GOOGLon", name: "Alphabet Class A", token: "bnb-0x091fc7778e6932d4009b087b191d1ee3bac5729a.omdep.near" },
  { symbol: "METAon", name: "Meta Platforms", token: "bnb-0xd7df5863a3e742f0c767768cdfcb63f09e0422f6.omdep.near" },
  { symbol: "MSFTon", name: "Microsoft", token: "bnb-0x6bfe75d1ad432050ea973c3a3dcd88f02e2444c3.omdep.near" },
  { symbol: "AMZNon", name: "Amazon", token: "bnb-0x4553cfe1c09f37f38b12dc509f676964e392f8fc.omdep.near" },
  { symbol: "HOODon", name: "Robinhood Markets", token: "bnb-0x19601179a60f55ff6636f5d1a8b6671053bd60a8.omdep.near" },
  { symbol: "INTCon", name: "Intel", token: "bnb-0xa528caaa2f96090e379d43f90834c75df54d6e74.omdep.near" },
  { symbol: "MRVLon", name: "Marvell Technology", token: "bnb-0x1501ec83ffef405b4331cc4f73277a40fb0c627d.omdep.near" },
  { symbol: "CRCLon", name: "Circle Internet Group", token: "bnb-0x992879cd8ce0c312d98648875b5a8d6d042cbf34.omdep.near" },
  { symbol: "SPYon", name: "SPDR S&P 500", token: "bnb-0x6a708ead771238919d85930b5a0f10454e1c331a.omdep.near" },
  { symbol: "QQQon", name: "Invesco QQQ", token: "bnb-0x0cde6936d305d5b34667fc46425e852efd73559a.omdep.near" },
  { symbol: "GLDon", name: "SPDR Gold Shares", token: "bnb-0xfa9a1e901085e269f6d428f79cd5252d8b919344.omdep.near" },
  { symbol: "IAUon", name: "iShares Gold Trust", token: "bnb-0xcb2a0f46f67dc4c58a316f1c008edef5c2311795.omdep.near" },
  { symbol: "SLVon", name: "iShares Silver Trust", token: "bnb-0x8b872732b07be325a8803cdb480d9d20b6f8d11b.omdep.near" },
  { symbol: "TLTon", name: "20+ Year Treasury", token: "bnb-0xf69e40069ac227c11459e3f4e8a446b3401616b6.omdep.near" },
  { symbol: "SGOVon", name: "0-3 Month Treasury", token: "bnb-0xc008c5f579ec1450f20099c39f587547e27c7523.omdep.near" },
  { symbol: "TIPon", name: "TIPS Bond", token: "bnb-0x2ac26ec236df5d1d2ad1a6dd4e448a90e45dc35d.omdep.near" },
  { symbol: "AGGon", name: "Core US Aggregate Bond", token: "bnb-0x08ce97f3d5cf11e577d091ab048bc5e2eae3fabb.omdep.near" },
];

export function findStock(input: string): Stock | undefined {
  const s = input.trim().replace(/^\$/, "").toLowerCase();
  return STOCKS.find((x) => x.token === s || x.symbol.toLowerCase() === s || x.symbol.toLowerCase() === `${s}on`);
}
