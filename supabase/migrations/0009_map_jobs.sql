-- 문제 지도의 "Claude로 정리" 요청. 각자의 Claude 워커가 가져가서
-- 아직 분류 안 된 문제에 분류(problem_categories)를 붙이고 문제 연결(problem_links)을 더한다.
create table public.map_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  result jsonb,                                -- { classified, links, total }
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index map_jobs_owner_idx on public.map_jobs (owner_id, created_at);

alter table public.map_jobs enable row level security;
create policy "own rows" on public.map_jobs for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

-- 연결은 확장 방향 하나로만 저장한다: kind='extends'면 from(쉬운 쪽) → to(확장 버전).
-- 예전에 'base'로 저장한 줄은 방향을 뒤집어 'extends'로 바꾼다.
update public.problem_links
  set from_judge = to_judge, from_problem = to_problem, from_title = to_title,
      to_judge = from_judge, to_problem = from_problem, to_title = from_title, kind = 'extends'
  where kind = 'base';
alter table public.problem_links drop constraint if exists problem_links_kind_check;
alter table public.problem_links add constraint problem_links_kind_check check (kind in ('extends', 'similar'));

-- 분류 이름을 정해진 목록에 맞춘다.
update public.problem_categories set category = '스택/큐' where category = '스택';
