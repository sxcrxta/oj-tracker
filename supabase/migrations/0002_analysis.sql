-- 문제 정보 (분석 프롬프트에 넣을 문제 설명). 사용자별로 저장해서 다른 사람이 내용을 바꿀 수 없게 한다.
create table public.problems (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  judge text not null default 'dshs',
  problem_id text not null,
  title text,
  statement text,
  statement_has_images boolean not null default false,
  examples jsonb not null default '[]'::jsonb,
  time_limit_ms integer,
  memory_limit_kb integer,
  testcase_count integer,
  tags jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  primary key (owner_id, judge, problem_id)
);

-- 분석 결과. kind = 'problem'(문제별) | 'overall'(종합), engine = 'gemma' | 'claude'
-- status: queued(대기) → running → done | error, 또는 needs_claude(Claude 분석 필요)
create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  judge text not null default 'dshs',
  problem_id text,
  kind text not null check (kind in ('problem', 'overall')),
  engine text not null check (engine in ('gemma', 'claude')),
  model text,
  status text not null check (status in ('queued', 'running', 'done', 'error', 'needs_claude')),
  route_reason text,
  submission_ids text[] not null default '{}',
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'problem') = (problem_id is not null))
);
create index analyses_owner_problem_idx on public.analyses (owner_id, kind, judge, problem_id, created_at desc);
create index analyses_claude_queue_idx on public.analyses (owner_id, created_at) where engine = 'claude' and status = 'queued';

-- 로컬 Claude 워커의 연결 상태
create table public.claude_workers (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  model text,
  last_seen timestamptz not null default now()
);

alter table public.problems enable row level security;
alter table public.analyses enable row level security;
alter table public.claude_workers enable row level security;

create policy "own rows" on public.problems for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "own rows" on public.analyses for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "own rows" on public.claude_workers for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
