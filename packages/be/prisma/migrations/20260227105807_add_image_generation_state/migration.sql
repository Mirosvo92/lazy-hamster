-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "analysis_data" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "image_prompts" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "source_image_url" TEXT NOT NULL DEFAULT '';
