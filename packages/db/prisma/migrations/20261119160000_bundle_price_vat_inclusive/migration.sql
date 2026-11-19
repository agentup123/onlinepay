-- The 30-card bundle is sold for 30.00 AED including VAT (DECISIONS D12).
-- Stored prices are VAT-exclusive: 28.57 AED + 1.43 AED VAT = 30.00 AED.
-- Only touches the bundle if it still has the original 30.00-excl-VAT price.
UPDATE "Bundle" SET "priceFils" = 2857, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'CARDS_30' AND "priceFils" = 3000;
