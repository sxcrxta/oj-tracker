create table public.submissions (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  judge text not null default 'dshs',          -- 채점 사이트 (확장 대비)
  submission_id text not null,                 -- 사이트 측 제출 ID
  judge_user_id text,                          -- 사이트 측 사용자 ID
  problem_id text not null,
  problem_title text,
  contest_id text,
  language text,
  status text,
  verdict text,
  max_time_ms integer,
  max_memory_kb integer,
  score numeric,
  max_score numeric,
  source_code text,
  compile_output text,
  testcase_results jsonb not null default '[]'::jsonb,
  failed_testcase integer,                     -- 처음 틀린 테스트케이스 번호 (1부터)
  submitted_at timestamptz not null,
  raw jsonb,
  saved_at timestamptz not null default now(),
  primary key (owner_id, judge, submission_id)
);

create index submissions_owner_problem_idx on public.submissions (owner_id, judge, problem_id, submitted_at desc);
create index submissions_owner_time_idx on public.submissions (owner_id, submitted_at desc);

alter table public.submissions enable row level security;

create policy "own rows: select" on public.submissions for select to authenticated using ((select auth.uid()) = owner_id);
create policy "own rows: insert" on public.submissions for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "own rows: update" on public.submissions for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "own rows: delete" on public.submissions for delete to authenticated using ((select auth.uid()) = owner_id);
