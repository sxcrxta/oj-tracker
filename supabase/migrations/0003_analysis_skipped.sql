-- 분석할 필요가 없는 문제(빈 코드만 틀림 등)를 기록하기 위한 상태
alter table public.analyses drop constraint analyses_engine_check;
alter table public.analyses add constraint analyses_engine_check check (engine in ('gemma', 'claude', 'none'));
alter table public.analyses drop constraint analyses_status_check;
alter table public.analyses add constraint analyses_status_check check (status in ('queued', 'running', 'done', 'error', 'needs_claude', 'skipped'));
