import { PrismaClient } from '../generated/prisma/index.js';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { id: 'default-user-001' },
    update: {},
    create: {
      id: 'default-user-001',
      name: 'Default User',
    },
  });
  console.log('Seeded user:', user);

  const project = await prisma.project.upsert({
    where: { id: 'default-project-001' },
    update: {},
    create: {
      id: 'default-project-001',
      userId: user.id,
      name: 'Default Project',
    },
  });
  console.log('Seeded project:', project);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
