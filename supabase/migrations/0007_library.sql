-- 코드 정리창: 한 문제에 여러 풀이를 저장한다 (예: 바텀업 DP, 탑다운 DP).
create table public.solutions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  judge text not null default 'dshs',
  problem_id text not null,
  problem_title text,
  title text not null default '',            -- 풀이 이름 (예: 탑다운 메모이제이션)
  code text not null,
  language text not null default 'cpp',
  approach text default '',                  -- 핵심 아이디어
  complexity text default '',                -- 시간/공간 복잡도
  note text default '',                      -- 내 메모
  source_submission_id text,                 -- 제출에서 가져왔다면 그 제출
  explain_status text not null default 'idle' check (explain_status in ('idle', 'queued', 'running', 'done', 'error')),
  explain_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index solutions_owner_problem_idx on public.solutions (owner_id, judge, problem_id, created_at);
create index solutions_explain_queue_idx on public.solutions (owner_id, updated_at) where explain_status = 'queued';

-- 문제 연결: kind = 'extends'(확장 버전) | 'base'(기본 버전) | 'similar'(비슷한 문제)
-- extends와 base는 서로 짝이라 한 줄만 저장하고, 반대 방향은 읽을 때 뒤집어서 보여준다.
create table public.problem_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_judge text not null,
  from_problem text not null,
  from_title text,
  to_judge text not null,
  to_problem text not null,
  to_title text,
  kind text not null check (kind in ('extends', 'base', 'similar')),
  note text default '',
  created_at timestamptz not null default now(),
  unique (owner_id, from_judge, from_problem, to_judge, to_problem, kind),
  check (not (from_judge = to_judge and from_problem = to_problem))
);
create index problem_links_owner_idx on public.problem_links (owner_id);

alter table public.solutions enable row level security;
alter table public.problem_links enable row level security;
create policy "own rows" on public.solutions for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "own rows" on public.problem_links for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
