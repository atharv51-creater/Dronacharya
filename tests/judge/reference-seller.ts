// A reference seller written the way the x402 v2 quickstart writes one: only @x402/express,
// x402ResourceServer, HTTPFacilitatorClient and ExactEvmScheme; none of this project's seller kit.
// The judges use sellers like this; so does our test pack.
//
//   honest       402 matches what we register; returns a real-looking catalogue page
//   overprice    registered at the listed price, but its 402 asks 0.010 USDC
//   wrong-payto  its 402 names a different payTo than the one registered
//   junk         200 with output that breaks the schema it was registered with (and it settles)

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

export type ReferenceMode = "honest" | "overprice" | "wrong-payto" | "junk";

export interface ReferenceSeller {
  mode: ReferenceMode;
  url: string;
  /** What the 402 actually asks, for the report. */
  advertised: { price: string; payTo: string };
  close(): void;
}

export async function startReferenceSeller(opts: {
  mode: ReferenceMode;
  listedPrice: string; // e.g. "$0.001"
  payTo: string;
  otherPayTo: string;
  facilitatorUrl: string;
}): Promise<ReferenceSeller> {
  const price = opts.mode === "overprice" ? "$0.010" : opts.listedPrice;
  const payTo = opts.mode === "wrong-payto" ? opts.otherPayTo : opts.payTo;

  const app = express();
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: opts.facilitatorUrl })).register("eip155:84532", new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      { "GET /scrape": { accepts: [{ scheme: "exact", price, network: "eip155:84532", payTo }], description: "Reference catalogue page", mimeType: "application/json" } },
      server,
    ),
  );
  app.get("/scrape", (req, res) => {
    if (opts.mode === "junk") {
      res.json({ result: "¯\\_(ツ)_/¯" });
      return;
    }
    const page = Number(req.query.page ?? 1) || 1;
    res.json({
      source: `https://books.toscrape.com/catalogue/page-${page}.html`,
      page,
      totalPages: 50,
      hasNext: page < 50,
      category: null,
      books: [
        { title: "Reference Book", priceGbp: 12.34, rating: 5, inStock: true, availability: "In stock", url: "https://books.toscrape.com/catalogue/reference/index.html", upc: "ref", description: "A reference description." },
      ],
    });
  });

  const http = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = http.address() as AddressInfo;
  return {
    mode: opts.mode,
    url: `http://127.0.0.1:${port}/scrape`,
    advertised: { price, payTo },
    close: () => {
      http.closeAllConnections?.();
      http.close();
    },
  };
}
