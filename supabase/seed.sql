-- ---------------------------------------------------------------------------
-- Starter data. Runs automatically on `supabase db reset`.
--
-- No user accounts here: create yours in the Supabase Dashboard
-- (Authentication -> Users -> Add user), then promote it to admin with the
-- statement at the bottom of supabase/schema.sql.
-- ---------------------------------------------------------------------------

insert into public.templates (name, subject, body, variables)
values (
  'Default cold outreach',
  'Quick idea for {{business_name}}',
  E'Hi {{first_name}},\n\n' ||
  E'I came across {{business_name}} in {{city}} and noticed {{personalization}}.\n\n' ||
  E'We build AI automation for {{niche}} usually lead capture, follow-up and ' ||
  E'a website chatbot that answers the questions your team keeps retyping.\n\n' ||
  E'Worth a short call next week?\n\n' ||
  E'{{signature}}',
  array['first_name', 'business_name', 'city', 'niche', 'personalization', 'signature']
)
on conflict (lower(name)) do nothing;

insert into public.campaigns (name, description, active, daily_limit, template_id)
select
  'Sheet2 international outreach',
  'Enriched leads imported from Leads.xlsx (Sheet2). Inactive until reviewed.',
  false,
  50,
  t.id
from public.templates t
where lower(t.name) = 'default cold outreach'
on conflict (lower(name)) do nothing;
