-- AlterTable
ALTER TABLE "Business" ADD COLUMN "bvumCeilingOverride" BIGINT;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SendAllowanceLedger";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "pricePerMonth" INTEGER NOT NULL,
    "tagline" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "productId" TEXT,
    "talkToSales" BOOLEAN NOT NULL DEFAULT false,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "creditsPerMonth" INTEGER NOT NULL,
    "staffSeats" INTEGER NOT NULL,
    "bvumCeiling" BIGINT
);
-- creditsPerMonth (new, NOT NULL) is backfilled to 50 for any pre-existing rows; the plan
-- catalog is re-seeded straight after migration with the correct rev-2 grants per tier.
INSERT INTO "new_Plan" ("bvumCeiling", "creditsPerMonth", "features", "id", "name", "pricePerMonth", "productId", "recommended", "staffSeats", "tagline", "talkToSales") SELECT "bvumCeiling", 50, "features", "id", "name", "pricePerMonth", "productId", "recommended", "staffSeats", "tagline", "talkToSales" FROM "Plan";
DROP TABLE "Plan";
ALTER TABLE "new_Plan" RENAME TO "Plan";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

