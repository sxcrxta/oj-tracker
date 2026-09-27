-- 문제 분류 (DP, 정렬 등). 연결 지도에서 같은 분류끼리 모아 보여준다. 한 문제에 분류 하나.
create table public.problem_categories (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  judge text not null,
  problem_id text not null,
  category text not null check (length(category) between 1 and 30),
  updated_at timestamptz not null default now(),
  primary key (owner_id, judge, problem_id)
);

alter table public.problem_categories enable row level security;
create policy "own rows" on public.problem_categories for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
