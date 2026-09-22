-- 자체 온라인 저지 ("연습장"). 문제 등록은 관리자만, 공개된 문제는 로그인한 모두가 푼다.
-- 제출 기록은 기존 submissions 테이블에 judge = 'self'로 저장한다.

create table public.oj_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.oj_admins enable row level security;
create policy "admins see themselves" on public.oj_admins for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.is_oj_admin() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select exists (select 1 from public.oj_admins where user_id = (select auth.uid())) $$;
revoke execute on function public.is_oj_admin() from public, anon;
grant execute on function public.is_oj_admin() to authenticated;

create table public.oj_problems (
  id serial primary key,
  title text not null,
  statement text not null default '',
  input_spec text not null default '',
  output_spec text not null default '',
  examples jsonb not null default '[]'::jsonb,         -- [{ input, output }]
  time_limit_ms integer not null default 1000,
  memory_limit_kb integer not null default 262144,
  difficulty text,
  tags text[] not null default '{}',
  source text not null default 'manual' check (source in ('manual', 'claude')),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.oj_problems enable row level security;
create policy "read published or admin" on public.oj_problems for select to authenticated
  using (published or (select public.is_oj_admin()));
create policy "admin writes" on public.oj_problems for all to authenticated
  using ((select public.is_oj_admin())) with check ((select public.is_oj_admin()));

-- 브라우저에서 채점하므로 공개 문제의 테스트케이스는 푸는 사람도 읽을 수 있다 (연습용이라 허용).
create table public.oj_testcases (
  problem_id integer not null references public.oj_problems(id) on delete cascade,
  idx integer not null,
  input text not null,
  output text not null,
  primary key (problem_id, idx)
);
alter table public.oj_testcases enable row level security;
create policy "read if problem readable" on public.oj_testcases for select to authenticated
  using (exists (select 1 from public.oj_problems p where p.id = problem_id and (p.published or (select public.is_oj_admin()))));
create policy "admin writes" on public.oj_testcases for all to authenticated
  using ((select public.is_oj_admin())) with check ((select public.is_oj_admin()));

-- 정답 코드와 생성기는 관리자만 본다.
create table public.oj_problem_private (
  problem_id integer primary key references public.oj_problems(id) on delete cascade,
  solution_code text,
  generator_code text,
  notes text
);
alter table public.oj_problem_private enable row level security;
create policy "admin only" on public.oj_problem_private for all to authenticated
  using ((select public.is_oj_admin())) with check ((select public.is_oj_admin()));

-- Claude 문제 만들기 요청. 관리자의 Claude 워커가 처리한다.
create table public.oj_problem_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  request jsonb not null,                               -- { topic, difficulty, notes, use_weakness }
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  problem_id integer references public.oj_problems(id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.oj_problem_jobs enable row level security;
create policy "admin own jobs" on public.oj_problem_jobs for all to authenticated
  using ((select public.is_oj_admin()) and (select auth.uid()) = owner_id)
  with check ((select public.is_oj_admin()) and (select auth.uid()) = owner_id);

-- 관리자 등록은 배포할 때 직접 한다:
--   insert into public.oj_admins (user_id) values ('<관리자 user id>');
