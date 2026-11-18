---- MODULE Identity ----
EXTENDS Naturals
CONSTANT Validate
VARIABLES revision, seen, handled
vars == <<revision, seen, handled>>
Init == revision = 0 /\ seen = {} /\ handled = {}
\* src/consumer.rs:40-77 validation and local transaction. id is the revision encoded
\* by the event key for this record. handled observes successful returns only.
Deliver(r,id) ==
    IF Validate /\ id # r THEN UNCHANGED vars
    ELSE /\ seen' = seen \cup {id}
         /\ revision' = IF id \in seen \/ r < revision THEN revision ELSE r
         /\ handled' = handled \cup {r}
Next == \E r,id \in 1..2 : Deliver(r,id)
CoversSuccess == \A r \in handled : r <= revision
====
