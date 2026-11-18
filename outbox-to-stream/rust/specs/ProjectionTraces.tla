---- MODULE ProjectionTraces ----
EXTENDS Projection, Sequences
VARIABLE i
Trace == <<[op |-> "init", r |-> 0, rev |-> 0, ids |-> {}],
           [op |-> "apply", r |-> 2, rev |-> 2, ids |-> {2}],
           [op |-> "apply", r |-> 1, rev |-> 2, ids |-> {1,2}],
           [op |-> "apply", r |-> 2, rev |-> 2, ids |-> {1,2}],
           [op |-> "snapshot", r |-> 3, rev |-> 3, ids |-> {1,2}],
           [op |-> "apply", r |-> 3, rev |-> 3, ids |-> {1,2,3}]>>
TraceInit == i = 1 /\ Init /\ revision = Trace[1].rev /\ seen = Trace[1].ids
TraceNext == \/ /\ i < Len(Trace)
                /\ LET t == Trace[i+1] IN
                   /\ IF t.op = "apply" THEN Apply(t.r) ELSE Snapshot(t.r)
                   /\ revision' = t.rev /\ seen' = t.ids
                /\ i' = i+1
             \/ /\ i = Len(Trace) /\ UNCHANGED <<vars,i>>
====
