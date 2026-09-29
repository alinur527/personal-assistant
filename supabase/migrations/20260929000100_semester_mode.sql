-- Rename the academic mode without discarding existing manual overrides or seasons.
alter table public.life_modes
  drop constraint if exists life_modes_mode_allowed;

alter table public.life_seasons
  drop constraint if exists life_seasons_mode_allowed;

update public.life_modes set mode = 'semester' where mode = 'trimester';
update public.life_seasons set mode = 'semester' where mode = 'trimester';

alter table public.life_modes
  add constraint life_modes_mode_allowed check (
    mode in (
      'exam_war', 'practice', 'recovery_setup', 'summer_term', 'summer',
      'semester', 'recovery', 'project_sprint', 'maintenance'
    )
  );

alter table public.life_seasons
  add constraint life_seasons_mode_allowed check (
    mode in (
      'exam_war', 'practice', 'recovery_setup', 'summer_term', 'summer',
      'semester', 'recovery', 'project_sprint', 'maintenance'
    )
  );
