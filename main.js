import { Decoder } from "./src/decoder.js";
// import { chunk, filterValues } from "jsr:@std/collections";

const main = async () => {
  const decoder = new Decoder();
  await decoder.decode("data/parrot.jpeg");
};

await main();
