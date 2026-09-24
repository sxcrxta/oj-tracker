-- 문제를 푸는 중에 받는 단계별 힌트. 관리자의 Claude 워커가 아니라 "각자의" Claude 워커가 처리한다.
-- kind = 'level' (1~3단계 힌트) | 'code' (지금 내 코드를 보고 짚어주기)
create table public.hints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  judge text not null default 'dshs',
  problem_id text not null,
  kind text not null check (kind in ('level', 'code')),
  level integer,
  code text,                                   -- kind='code'일 때 진단할 코드
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  model text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'level') = (level is not null))
);
create index hints_owner_problem_idx on public.hints (owner_id, judge, problem_id, created_at);
create index hints_queue_idx on public.hints (owner_id, created_at) where status = 'queued';

alter table public.hints enable row level security;
create policy "own rows" on public.hints for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
