Fullstack Engineer - Assessment Brief 

Objective 

This system is the operational backbone for managing deliverables of high-value projects. It must support the collaborative workflow of a medium-to-large team spanning multiple disciplines (Product Management, UI/UX, Frontend, and Backend), while also serving data visibility to the Client side. 

The main challenge of this system is not simple CRUD, but the enforcement of State-Based Permissions (permissions that change based on task status), Inter-Task Dependencies (dependencies between tasks), and the prevention of Data Concurrency Conflicts when many actors manipulate data at the same time. 

Actors, Departments & Access Rules (RBAC + ABAC) 

User access depends not only on Role (Who are they?), but also on Department (Which team are they from?) and Task State (What is the current task status?). 

Role 1: Product Manager (PM) 

Has full read/write access to projects and tasks, but cannot move a task status from In Progress to Done (only the executor can complete it). 

Can define Task Dependencies (Task B cannot start before Task A is completed). 

Role 2: Internal Team (UI/UX, Frontend, Backend) 

Can only view task details on projects assigned to them. 

State-Based Edit: A Frontend Engineer can only change a task status to In Progress if the UI/UX task it depends on is already Done. If not, the action button must be locked (disabled) both in the UI and as API protection (backend validation). 

Cannot change the core description of a task; can only upload work attachments and change status. 

Role 3: Client Guest (Multi-Tenant Isolation) 

Absolute data isolation: Can only see aggregate metrics of their own project (e.g. "50% Complete"). 

Can only see tasks explicitly flagged as Client-Visible by the PM. 

Data Masking: All internal identities (engineer names, avatars, departments) and internal comment history must be automatically filtered out from the API response, not hidden via CSS/Frontend. 

Tech Stack 

Backend: 

Language: TypeScript 

Runtime: Bun 

HTTP Framework: Hono 

ORM: Prisma 

Database: PostgreSQL 

Auth: JWT (jsonwebtoken) 

Filtering/Pagination: @nodewave/prisma-ezfilter 

Validation: Zod / entity DTOs. 

Frontend: 

Framework: Next.js 16 (App Router) 

UI: React 19 + TypeScript (strict) 

Styling: Tailwind CSS 4 + Radix UI / shadcn 

Data Fetching: TanStack Query 5 + Axios 

State: Zustand 5 

Forms: React Hook Form + Zod 

Tooling: Biome + Husky + Commitlint 

Core Features & Complex Business Logic 

Development focuses on handling edge-cases and architectural resilience: 

Dependency-Aware Task Board. The task management system does not merely move cards from left to right. If Task A (UI Design) and Task B (Backend API Integration) are prerequisites for Task C (Frontend Slicing), then Task C is automatically Blocked and cannot be worked on by the Frontend Engineer until both Task A and Task B are Done. 

Concurrency & Optimistic Locking. The candidate must handle Race Condition scenarios. If a PM is editing a task description while at the same second an Engineer changes that task status to Done, the system must not overwrite each other's data. There must be a rejection mechanism (409 Conflict) or a safe merge of changes. 

Immutable Audit Trail & Soft Deletes. Data in this system is critical. No entity is ever truly deleted (Soft Delete is mandatory). Every change to any field within a Task (status change, description change, assignee change) must be recorded immutably in a separate Log table, including: User ID, Timestamp, Changed Column, Old Value, New Value. 

Daily Standup Auto-Summary (Optional/Bonus). The system has a background job or dedicated endpoint that can summarize all Audit Trail entries from the previous day for a project, producing structured JSON data containing a summary of "What was completed yesterday" and "What is blocked today" per department. 

Standard Requirements 

Authentication 

Register, Login, and Logout with JWT-based sessions and guarded/protected routes on both the API and the UI. 

List, Filtering, Searching & Pagination 

All list endpoints must follow the standard query contract documented here: 

Filtering, Pagination & Searching - Standard Documentation 

User Experience 

Clear loading, empty, and error states, with a responsive layout that follows NodeWave brand colors. 

Deployment 

Deploy the backend API to a publicly reachable URL (Railway, Render, Fly.io, VPS, or similar), with PostgreSQL provisioned and Prisma migrations + seeds applied. 

Deploy the frontend (Vercel, Railway, or similar) pointed at the live backend via NEXT_PUBLIC_BE_URL. 

Ensure all seeded accounts (PM, Internal Team, Client Guest) can log in on the live deployment. 

Technical Requirements 

Type-safe code (TypeScript strict) on both backend and frontend. 

Meaningful commit history following Conventional Commits. 

Testing (optional): at least unit tests for a service/repository and one key UI component. 

CI (optional): GitHub Actions running format + lint + build. 

Source Code 

Two separate private GitHub repositories: one for the backend and one for the frontend. Do not use a monorepo. 

Invite collaborators to both repositories: rigenski, nodewavescout. 

Deliverables 

Submit a short documentation that contains everything a reviewer needs to evaluate the work. It must include: 

Live application URLs (frontend and backend) along with seeded account credentials for each role (PM, Internal Team, Client Guest). 

Links to both private GitHub repositories (backend and frontend). 

An architecture overview explaining how RBAC + ABAC, state-based permissions, dependencies, concurrency, and audit trail are implemented. 

3-5 screenshots (auth, task board with dependencies, a Blocked task state, and the Client Guest view) and a screen recording under 3 minutes demonstrating the flow on the live app. 

Timeline 

Deadline: 72 hours after receiving this brief. 

Submission 

Send your submission to: https://tally.so/r/LZ87Xz 

Include the short documentation (with all links, credentials, and media) directly in or attached to the email. 

 