/*
  Warnings:

  - You are about to drop the column `currency_id` on the `products_services` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "products_services" DROP CONSTRAINT "products_services_currency_id_fkey";

-- AlterTable
ALTER TABLE "products_services" DROP COLUMN "currency_id",
ADD COLUMN     "currency_code" CHAR(3);

-- AddForeignKey
ALTER TABLE "products_services" ADD CONSTRAINT "products_services_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE SET NULL ON UPDATE CASCADE;
