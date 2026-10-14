-- 연습장 "빈칸 채우기" 문제. 코드 틀이 주어지고, 푸는 사람은 빈칸(함수 몸통 등)만 채운다.
-- 채점할 때는 틀에 빈칸 코드를 끼워 넣은 전체 코드를 평소처럼 테스트케이스로 돌린다.
--   skeleton = { template, blanks: [{ id, title, guide }] }
--   template 안에서 한 줄 전체가 {{id}}인 줄이 빈칸 자리다. null이면 일반 문제.
alter table public.oj_problems add column skeleton jsonb;
