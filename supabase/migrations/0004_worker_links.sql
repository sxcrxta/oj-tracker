-- 대시보드에서 발급하는 일회용 Claude 워커 연결 코드. Edge Function(service role)만 읽고 쓴다.
create table public.worker_links (
  code_hash text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table public.worker_links enable row level security;
