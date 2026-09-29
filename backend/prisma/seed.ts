/**
 * Seed data.
 *
 * The scenario is built to make every hard requirement of the brief observable
 * in one login:
 *
 *  - **Two client organisations** so multi-tenant isolation is demonstrable:
 *    signing in as Kopi Kita's guest must reveal nothing of Nusantara Digital.
 *  - **A dependency chain** UI/UX + Backend -> Frontend -> QA -> Release, with
 *    the Frontend task sitting in BLOCKED, so the state-based permission and
 *    the reconciler are both visible on the board.
 *  - **Back-dated audit history** so the standup summary has something to
 *    summarise for "yesterday" rather than an empty day.
 *  - **A CLIENT_GUEST** account that only exists because a PM provisioned it.
 *
 * Idempotent: every row uses a deterministic UUID, so re-running converges
 * rather than duplicating. The audit log is append-only by database trigger, so
 * re-seeding deliberately does *not* rewrite history — the existing entries stay
 * and are reused.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { hashPassword } from '../src/lib/password.ts';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const ID = {
  orgNusantara: '11111111-1111-4111-8111-111111111111',
  orgKopiKita: '22222222-2222-4222-8222-222222222222',

  pm: 'aaaaaaaa-0000-4000-8000-000000000001',
  ux: 'aaaaaaaa-0000-4000-8000-000000000002',
  fe: 'aaaaaaaa-0000-4000-8000-000000000003',
  be: 'aaaaaaaa-0000-4000-8000-000000000004',
  qa: 'aaaaaaaa-0000-4000-8000-000000000005',
  guestNusantara: 'aaaaaaaa-0000-4000-8000-000000000006',
  guestKopiKita: 'aaaaaaaa-0000-4000-8000-000000000007',
  pmKopi: 'aaaaaaaa-0000-4000-8000-000000000008',

  projNusantara: 'bbbbbbbb-0000-4000-8000-000000000001',
  projKopi: 'bbbbbbbb-0000-4000-8000-000000000002',

  tDesign: 'cccccccc-0000-4000-8000-000000000001',
  tApi: 'cccccccc-0000-4000-8000-000000000002',
  tSlicing: 'cccccccc-0000-4000-8000-000000000003',
  tQa: 'cccccccc-0000-4000-8000-000000000004',
  tRelease: 'cccccccc-0000-4000-8000-000000000005',
  tAuth: 'cccccccc-0000-4000-8000-000000000006',
  tAnalytics: 'cccccccc-0000-4000-8000-000000000007',

  kDesign: 'dddddddd-0000-4000-8000-000000000001',
  kPos: 'dddddddd-0000-4000-8000-000000000002',
} as const;

const PASSWORD = 'Password123!';

/** Days before "now", so the standup summary always has yesterday's activity. */
const daysAgo = (n: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getUTCDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

async function main() {
  console.log('Seeding NodeWave…');
  const passwordHash = await hashPassword(PASSWORD);

  // -------------------------------------------------------------------------
  // Organisations
  // -------------------------------------------------------------------------
  for (const [id, name, slug] of [
    [ID.orgNusantara, 'Nusantara Digital', 'nusantara-digital'],
    [ID.orgKopiKita, 'Kopi Kita Group', 'kopi-kita-group'],
  ] as const) {
    await prisma.clientOrganization.upsert({
      where: { id },
      update: { name },
      create: { id, name, slug },
    });
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  const users = [
    {
      id: ID.pm,
      email: 'pm@nodewave.dev',
      name: 'Rani Prameswari',
      role: 'PRODUCT_MANAGER' as const,
      department: 'PRODUCT' as const,
      clientOrgId: null,
      avatarUrl: null,
    },
    {
      id: ID.ux,
      email: 'ux@nodewave.dev',
      name: 'Dimas Prasetyo',
      role: 'INTERNAL_TEAM' as const,
      department: 'UI_UX' as const,
      clientOrgId: null,
      avatarUrl: null,
    },
    {
      id: ID.fe,
      email: 'fe@nodewave.dev',
      name: 'Sari Andriani',
      role: 'INTERNAL_TEAM' as const,
      department: 'FRONTEND' as const,
      clientOrgId: null,
      avatarUrl: null,
    },
    {
      id: ID.be,
      email: 'be@nodewave.dev',
      name: 'Bagus Hartono',
      role: 'INTERNAL_TEAM' as const,
      department: 'BACKEND' as const,
      clientOrgId: null,
      avatarUrl: null,
    },
    {
      id: ID.qa,
      email: 'qa@nodewave.dev',
      name: 'Maya Lestari',
      role: 'INTERNAL_TEAM' as const,
      department: 'BACKEND' as const,
      clientOrgId: null,
      avatarUrl: null,
    },
    {
      id: ID.guestNusantara,
      email: 'client@nusantaradigital.com',
      name: 'Rangga Kusuma',
      role: 'CLIENT_GUEST' as const,
      department: null,
      clientOrgId: ID.orgNusantara,
      avatarUrl: null,
    },
    {
      id: ID.guestKopiKita,
      email: 'client@kopikita.id',
      name: 'Citra Dewi',
      role: 'CLIENT_GUEST' as const,
      department: null,
      clientOrgId: ID.orgKopiKita,
      avatarUrl: null,
    },
    {
      id: ID.pmKopi,
      email: 'pm.kopi@nodewave.dev',
      name: 'Yusuf Maulana',
      role: 'PRODUCT_MANAGER' as const,
      department: 'PRODUCT' as const,
      clientOrgId: null,
      avatarUrl: null,
    },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: {
        name: user.name,
        role: user.role,
        department: user.department,
        clientOrgId: user.clientOrgId,
        isActive: true,
        deletedAt: null,
        passwordHash,
      },
      create: { ...user, passwordHash, isActive: true },
    });
  }
  console.log(`  ${users.length} users`);

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------
  const projects = [
    {
      id: ID.projNusantara,
      name: 'Nusantara Banking App Revamp',
      code: 'NUS-BANK',
      description:
        'Rebuild of the mobile banking experience: new onboarding, dashboard redesign, and a modernised payments API.',
      clientOrgId: ID.orgNusantara,
      status: 'ACTIVE' as const,
      startDate: daysAgo(21),
      dueDate: daysAgo(-14),
    },
    {
      id: ID.projKopi,
      name: 'Kopi Kita POS System',
      code: 'KKI-POS',
      description: 'Point-of-sale rollout across 40 outlets, with offline-first sync.',
      clientOrgId: ID.orgKopiKita,
      status: 'ACTIVE' as const,
      startDate: daysAgo(10),
      dueDate: daysAgo(-30),
    },
  ];

  for (const project of projects) {
    await prisma.project.upsert({
      where: { id: project.id },
      update: { name: project.name, description: project.description, status: project.status, deletedAt: null },
      create: project,
    });
  }
  console.log(`  ${projects.length} projects`);

  // -------------------------------------------------------------------------
  // Membership — the INTERNAL_TEAM read boundary
  // -------------------------------------------------------------------------
  const memberships = [
    [ID.projNusantara, ID.pm],
    [ID.projNusantara, ID.ux],
    [ID.projNusantara, ID.fe],
    [ID.projNusantara, ID.be],
    [ID.projNusantara, ID.qa],
    [ID.projNusantara, ID.guestNusantara],
    [ID.projKopi, ID.pmKopi],
    [ID.projKopi, ID.be],
    [ID.projKopi, ID.ux],
    [ID.projKopi, ID.guestKopiKita],
  ] as const;

  for (const [projectId, userId] of memberships) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { deletedAt: null },
      create: { projectId, userId },
    });
  }
  console.log(`  ${memberships.length} project memberships`);

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------
  const tasks = [
    {
      id: ID.tDesign,
      projectId: ID.projNusantara,
      title: 'Design system & onboarding screens',
      description:
        'Produce the Figma library for onboarding (signup, KYC, first login) and hand off annotated frames to frontend.',
      status: 'DONE' as const,
      priority: 'HIGH' as const,
      department: 'UI_UX' as const,
      assigneeId: ID.ux,
      isClientVisible: true,
      orderIndex: 0,
      estimateHours: 32,
      dueDate: daysAgo(5),
      createdById: ID.pm,
      startedAt: daysAgo(8, 9),
      completedAt: daysAgo(4, 16),
      createdAt: daysAgo(10),
    },
    {
      id: ID.tApi,
      projectId: ID.projNusantara,
      title: 'Payments & KYC API',
      description: 'Build the account and KYC endpoints, plus the payments gateway adapter with idempotent retries.',
      status: 'IN_PROGRESS' as const,
      priority: 'URGENT' as const,
      department: 'BACKEND' as const,
      assigneeId: ID.be,
      isClientVisible: true,
      orderIndex: 1,
      estimateHours: 48,
      dueDate: daysAgo(-2),
      createdById: ID.pm,
      startedAt: daysAgo(1, 9),
      completedAt: null,
      createdAt: daysAgo(10),
    },
    {
      // The showcase task: blocked by two unfinished prerequisites, so the
      // Frontend engineer's "Start" control is locked with a stated reason.
      id: ID.tSlicing,
      projectId: ID.projNusantara,
      title: 'Frontend slicing — onboarding & dashboard',
      description:
        'Build the onboarding and dashboard screens from the handoff. Cannot start until both the design library and the KYC API contract are delivered.',
      status: 'BLOCKED' as const,
      priority: 'HIGH' as const,
      department: 'FRONTEND' as const,
      assigneeId: ID.fe,
      isClientVisible: true,
      orderIndex: 2,
      estimateHours: 40,
      dueDate: daysAgo(-5),
      createdById: ID.pm,
      startedAt: null,
      completedAt: null,
      createdAt: daysAgo(10),
    },
    {
      id: ID.tQa,
      projectId: ID.projNusantara,
      title: 'Integration QA & accessibility pass',
      description:
        'End-to-end regression on the new flow, WCAG 2.2 AA audit, and load testing against the staging gateway.',
      status: 'TODO' as const,
      priority: 'MEDIUM' as const,
      department: 'BACKEND' as const,
      assigneeId: ID.qa,
      isClientVisible: true,
      orderIndex: 3,
      estimateHours: 24,
      dueDate: daysAgo(-7),
      createdById: ID.pm,
      startedAt: null,
      completedAt: null,
      createdAt: daysAgo(9),
    },
    {
      id: ID.tRelease,
      projectId: ID.projNusantara,
      title: 'Phased release to production',
      description: 'Blue/green rollout: 5% for 24h, then 25%, then full. Rollback plan signed off by the client.',
      status: 'TODO' as const,
      priority: 'HIGH' as const,
      department: 'PRODUCT' as const,
      assigneeId: ID.pm,
      isClientVisible: true,
      orderIndex: 4,
      estimateHours: 12,
      dueDate: daysAgo(-12),
      createdById: ID.pm,
      startedAt: null,
      completedAt: null,
      createdAt: daysAgo(9),
    },
    {
      // Internal only: not flagged for the client, so it must be invisible to
      // the guest on both the board and the detail view.
      id: ID.tAuth,
      projectId: ID.projNusantara,
      title: 'Migrate legacy token service',
      description:
        'Move the legacy auth service to short-lived JWTs with rotation. Internal workstream — not part of the client-visible scope.',
      status: 'IN_PROGRESS' as const,
      priority: 'MEDIUM' as const,
      department: 'BACKEND' as const,
      assigneeId: ID.be,
      isClientVisible: false,
      orderIndex: 5,
      estimateHours: 20,
      dueDate: daysAgo(-9),
      createdById: ID.pm,
      startedAt: daysAgo(2, 9),
      completedAt: null,
      createdAt: daysAgo(6),
    },
    {
      id: ID.tAnalytics,
      projectId: ID.projNusantara,
      title: 'Instrument funnel analytics',
      description: 'Emit onboarding funnel events to the data warehouse and build the completion dashboard.',
      status: 'TODO' as const,
      priority: 'LOW' as const,
      department: 'PRODUCT' as const,
      assigneeId: ID.pm,
      isClientVisible: true,
      orderIndex: 6,
      estimateHours: 10,
      dueDate: daysAgo(-20),
      createdById: ID.pm,
      startedAt: null,
      completedAt: null,
      createdAt: daysAgo(5),
    },
    {
      id: ID.kDesign,
      projectId: ID.projKopi,
      title: 'POS terminal UI design',
      description: 'Terminal interface for cashiers: fast-path keypad, offline indicator, cash drawer states.',
      status: 'IN_REVIEW' as const,
      priority: 'HIGH' as const,
      department: 'UI_UX' as const,
      assigneeId: ID.ux,
      isClientVisible: true,
      orderIndex: 0,
      estimateHours: 16,
      dueDate: daysAgo(-3),
      createdById: ID.pmKopi,
      startedAt: daysAgo(3, 9),
      completedAt: null,
      createdAt: daysAgo(7),
    },
    {
      id: ID.kPos,
      projectId: ID.projKopi,
      title: 'Offline sync engine',
      description: 'Conflict-free replicated transaction log so registers keep selling through a network outage.',
      status: 'IN_PROGRESS' as const,
      priority: 'URGENT' as const,
      department: 'BACKEND' as const,
      assigneeId: ID.be,
      isClientVisible: true,
      orderIndex: 1,
      estimateHours: 36,
      dueDate: daysAgo(-6),
      createdById: ID.pmKopi,
      startedAt: daysAgo(4, 9),
      completedAt: null,
      createdAt: daysAgo(7),
    },
  ];

  for (const task of tasks) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: { ...task, deletedAt: null },
      create: task,
    });
  }
  console.log(`  ${tasks.length} tasks`);

  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------
  const dependencies = [
    [ID.tSlicing, ID.tDesign, ID.pm], // Frontend waits on UI/UX
    [ID.tSlicing, ID.tApi, ID.pm], // and on the API contract
    [ID.tQa, ID.tSlicing, ID.pm],
    [ID.tRelease, ID.tQa, ID.pm],
    [ID.tAnalytics, ID.tSlicing, ID.pm],
    [ID.kPos, ID.kDesign, ID.pmKopi],
  ] as const;

  for (const [taskId, dependsOnTaskId, createdById] of dependencies) {
    await prisma.taskDependency.upsert({
      where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId } },
      update: {},
      create: { taskId, dependsOnTaskId, createdById },
    });
  }
  console.log(`  ${dependencies.length} dependencies`);

  // -------------------------------------------------------------------------
  // Audit history
  //
  // Written only when absent, because the table is append-only at the database
  // level: an UPDATE or DELETE would be rejected by the trigger even if this
  // script asked for it.
  // -------------------------------------------------------------------------
  const existing = await prisma.taskLog.count();

  if (existing === 0) {
    const log = (
      taskId: string,
      projectId: string,
      userId: string,
      action: string,
      column: string,
      oldValue: string | null,
      newValue: string | null,
      createdAt: Date,
      metadata?: object,
    ) =>
      prisma.taskLog.create({
        data: {
          taskId,
          projectId,
          userId,
          action: action as never,
          column,
          oldValue,
          newValue,
          createdAt,
          ...(metadata ? { metadata: metadata as never } : {}),
        },
      });

    const N = ID.projNusantara;
    const K = ID.projKopi;

    // --- 5 days ago: the design task was created and started ---------------
    await log(ID.tDesign, N, ID.pm, 'CREATED', 'task', null, 'Design system & onboarding screens', daysAgo(10));
    await log(ID.tDesign, N, ID.ux, 'STATUS_CHANGED', 'status', 'TODO', 'IN_PROGRESS', daysAgo(8, 9));
    await log(
      ID.tDesign,
      N,
      ID.ux,
      'DESCRIPTION_CHANGED',
      'description',
      'Produce the Figma library for onboarding',
      'Produce the Figma library for onboarding (signup, KYC, first login) and hand off annotated frames to frontend.',
      daysAgo(6, 14),
    );

    // --- 4 days ago: design completed (yesterday for a 4-day offset) --------
    await log(ID.tDesign, N, ID.ux, 'STATUS_CHANGED', 'status', 'IN_PROGRESS', 'DONE', daysAgo(4, 16));

    // --- 3 days ago -------------------------------------------------------
    await log(
      ID.tSlicing,
      N,
      ID.pm,
      'CREATED',
      'task',
      null,
      'Frontend slicing — onboarding & dashboard',
      daysAgo(3, 9),
    );
    await log(
      ID.tSlicing,
      N,
      ID.pm,
      'DEPENDENCY_ADDED',
      'dependsOn',
      null,
      'Design system & onboarding screens',
      daysAgo(3, 9),
    );

    // --- 2 days ago: API task started -------------------------------------
    await log(ID.tApi, N, ID.be, 'STATUS_CHANGED', 'status', 'TODO', 'IN_PROGRESS', daysAgo(2, 9));
    await log(
      ID.tApi,
      N,
      ID.be,
      'DESCRIPTION_CHANGED',
      'description',
      'Build the account and KYC endpoints',
      'Build the account and KYC endpoints, plus the payments gateway adapter with idempotent retries.',
      daysAgo(2, 11),
    );
    await log(ID.tAuth, N, ID.be, 'STATUS_CHANGED', 'status', 'TODO', 'IN_PROGRESS', daysAgo(2, 15));

    // --- yesterday: the busy day, so the standup has content --------------
    await log(ID.tSlicing, N, ID.pm, 'DEPENDENCY_ADDED', 'dependsOn', null, 'Payments & KYC API', daysAgo(1, 9));
    await log(ID.tSlicing, N, ID.pm, 'AUTO_BLOCKED', 'status', 'TODO', 'BLOCKED', daysAgo(1, 9), {
      systemInitiated: true,
      blockers: [{ taskId: ID.tApi, title: 'Payments & KYC API', status: 'IN_PROGRESS' }],
    });
    await log(ID.tQa, N, ID.qa, 'CREATED', 'task', null, 'Integration QA & accessibility pass', daysAgo(1, 10));
    await log(ID.tSlicing, N, ID.fe, 'COMMENT_ADDED', 'comment', null, '[internal comment]', daysAgo(1, 13), {
      commentId: 'seed-comment-1',
    });
    await log(ID.tApi, N, ID.be, 'STATUS_CHANGED', 'status', 'TODO', 'IN_PROGRESS', daysAgo(1, 14));
    await log(ID.tSlicing, N, ID.pm, 'VISIBILITY_CHANGED', 'isClientVisible', 'false', 'true', daysAgo(1, 16));

    // --- today, so far ----------------------------------------------------
    await log(ID.tAnalytics, N, ID.pm, 'CREATED', 'task', null, 'Instrument funnel analytics', daysAgo(0, 8));
    await log(ID.tApi, N, ID.be, 'COMMENT_ADDED', 'comment', null, '[internal comment]', daysAgo(0, 9));

    // --- second tenant, for the isolation demo ----------------------------
    await log(ID.kDesign, K, ID.pmKopi, 'CREATED', 'task', null, 'POS terminal UI design', daysAgo(7));
    await log(ID.kDesign, K, ID.ux, 'STATUS_CHANGED', 'status', 'TODO', 'IN_PROGRESS', daysAgo(3, 9));
    await log(ID.kDesign, K, ID.ux, 'STATUS_CHANGED', 'status', 'IN_PROGRESS', 'IN_REVIEW', daysAgo(1, 15));
    await log(ID.kPos, K, ID.be, 'STATUS_CHANGED', 'status', 'TODO', 'IN_PROGRESS', daysAgo(1, 10));
    await log(ID.kPos, K, ID.be, 'AUTO_BLOCKED', 'status', 'IN_PROGRESS', 'BLOCKED', daysAgo(1, 10), {
      systemInitiated: true,
      blockers: [{ taskId: ID.kDesign, title: 'POS terminal UI design', status: 'IN_PROGRESS' }],
    });

    const total = await prisma.taskLog.count();
    console.log(`  ${total} audit log entries`);
  } else {
    console.log(`  audit log already populated (${existing} entries, append-only — left untouched)`);
  }

  // -------------------------------------------------------------------------
  // A comment thread, to show that internal discussion is not exposed to guests
  // -------------------------------------------------------------------------
  const existingComments = await prisma.comment.count({ where: { taskId: ID.tSlicing } });
  if (existingComments === 0) {
    await prisma.comment.create({
      data: {
        id: 'eeeeeeee-0000-4000-8000-000000000001',
        taskId: ID.tSlicing,
        authorId: ID.fe,
        body: 'Handoff notes look good. I can start the shell layout now, but the KYC step form is blocked on the API contract.',
        isInternal: true,
      },
    });
    await prisma.comment.create({
      data: {
        taskId: ID.tSlicing,
        authorId: ID.pm,
        body: 'Client review is booked for Thursday — the onboarding screens are the part they care about.',
        isInternal: false,
      },
    });
  }

  console.log('\nSeed complete. Accounts (password for all: %s)\n', PASSWORD);
  console.log('  PRODUCT_MANAGER  pm@nodewave.dev              Rani Prameswari');
  console.log('  INTERNAL_TEAM    ux@nodewave.dev  (UI/UX)     Dimas Prasetyo');
  console.log('  INTERNAL_TEAM    fe@nodewave.dev  (Frontend) Sari Andriani');
  console.log('  INTERNAL_TEAM    be@nodewave.dev  (Backend)  Bagus Hartono');
  console.log('  INTERNAL_TEAM    qa@nodewave.dev  (Backend)  Maya Lestari');
  console.log('  CLIENT_GUEST     client@nusantaradigital.com  Rangga Kusuma  (org: Nusantara Digital)');
  console.log('  CLIENT_GUEST     client@kopikita.id           Citra Dewi    (org: Kopi Kita Group)\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
