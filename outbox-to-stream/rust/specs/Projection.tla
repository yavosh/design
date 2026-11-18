---- MODULE Projection ----
EXTENDS Naturals
CONSTANT MaxRevision, Guarded
VARIABLES revision, seen
vars == <<revision, seen>>
Init == revision = 0 /\ seen = {}
Revisions == 1..MaxRevision
Merge(r) == IF Guarded /\ revision > r THEN revision ELSE r

\* consumer.rs:54-81. One committed transaction per accepted event.
Apply(r) == /\ r \in Revisions
            /\ revision' = IF r \in seen THEN revision ELSE Merge(r)
            /\ seen' = seen \cup {r}

\* consumer.rs:108-123. Projection of a snapshot commit onto one record.
Snapshot(r) == /\ r \in Revisions
               /\ revision' = Merge(r)
               /\ UNCHANGED seen

Next == \E r \in Revisions : Apply(r) \/ Snapshot(r)
Spec == Init /\ [][Next]_vars
CoversSeen == \A r \in seen : r <= revision
Monotone == [][revision' >= revision]_vars
====
