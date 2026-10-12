/*
  Warnings:

  - Added the required column `previous_customer_status` to the `customer_credit_holds` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "customer_credit_holds" ADD COLUMN     "previous_customer_status" "CustomerStatus" NOT NULL;

-- AlterTable
ALTER TABLE "party_addresses" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;
