CREATE TABLE "token_usage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
