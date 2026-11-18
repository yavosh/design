use super::*;

pub const RECOVERY_MARGIN: i64 = 30;
#[derive(Debug, Clone)]
pub struct Claim {
    pub instance: i64,
    pub run_id: Option<String>,
    pub step: String,
    pub dispatch: i64,
    pub max_duration: u32,
    pub kind: String,
    pub entity: String,
    pub input: Value,
}
impl Claim {
    pub fn typed_input<T: serde::de::DeserializeOwned>(&self) -> Option<T> {
        serde_json::from_value(self.input.clone()).ok()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub target: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Outcome {
    Done {
        route: Option<Route>,
        payload: Value,
    },
    Retry {
        delay: u32,
        reason: String,
    },
    Defer {
        delay: u32,
    },
    Park {
        until: i64,
    },
    Failed {
        reason: String,
    },
}
impl Outcome {
    pub fn done(payload: Value) -> Self {
        Self::Done {
            route: None,
            payload,
        }
    }
}

fn enqueue(
    tx: &Transaction,
    instance: i64,
    key: &str,
    policy: &Step,
    input: &Value,
    at: i64,
) -> Result<()> {
    tx.execute("INSERT INTO execution(instance,step,stage,status,max_attempts,max_duration,next_at,input_data)
        VALUES(?1,?2,?3,'PENDING',?4,?5,?6,?7)",
            params![instance,key,stage(key),policy.max_attempts,policy.max_duration,at,input.to_string()])?;
    Ok(())
}
fn audit(
    tx: &Transaction,
    instance: i64,
    key: &str,
    actor: &str,
    detail: &str,
    reason: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO audit(instance,step,status,actor,detail,attempts,dispatch,reason)
        SELECT instance,step,status,?3,?4,attempts,dispatch_count,?5 FROM execution WHERE instance=?1 AND step=?2",
        params![instance,key,actor,detail,reason],
    )?;
    Ok(())
}
impl Engine {
    pub fn start(
        &mut self,
        name: &str,
        kind: &str,
        entity: &str,
        input: &Value,
        at: i64,
    ) -> Result<i64> {
        self.start_with_request_key(name, kind, entity, input, at, None)
    }

    pub fn start_with_request_key(
        &mut self,
        name: &str,
        kind: &str,
        entity: &str,
        input: &Value,
        at: i64,
        request_key: Option<&str>,
    ) -> Result<i64> {
        if request_key.is_some_and(|key| key.trim().is_empty()) {
            return Err("request key must not be blank".into());
        }
        let tx = self.write()?;
        if let Some(key) = request_key {
            let previous = tx
                .query_row(
                    "SELECT i.id,i.name=?2 AND i.kind=?3 AND i.entity=?4,e.input_data
                 FROM instance i JOIN definition d ON d.name=i.name AND d.version=i.version
                 JOIN execution e ON e.instance=i.id AND e.step=json_extract(d.spec,'$.start')
                 WHERE json_extract(i.selection_inputs,'$.requestKey')=?1",
                    params![key, name, kind, entity],
                    |r| Ok((r.get(0)?, r.get::<_, bool>(1)?, r.get::<_, String>(2)?)),
                )
                .optional()?;
            if let Some((id, same_request, original)) = previous {
                if same_request && serde_json::from_str::<Value>(&original)? == *input {
                    return Ok(id);
                }
                return Err("request key already used with different start parameters".into());
            }
        }
        let (version, json): (i64, String) = tx.query_row(
            "SELECT version,spec FROM definition WHERE name=?1 AND valid_until IS NULL",
            [name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let spec: Definition = serde_json::from_str(&json)?;
        let id=tx.query_row("INSERT INTO instance(kind,entity,name,version,selected_by,selection_inputs,status,
            current_step,started_at,last_progress_at) VALUES(?1,?2,?3,?4,'explicit-key',
            json_object('key',?3,'runId',lower(hex(randomblob(16))),'requestKey',?5),'ACTIVE',?6,?7,?7) RETURNING id",
            params![kind,entity,name,version,request_key,spec.start,at],|r|r.get(0))?;
        enqueue(&tx, id, &spec.start, &spec.steps[&spec.start], input, at)?;
        audit(&tx, id, &spec.start, "engine", "START", None)?;
        tx.commit()?;
        Ok(id)
    }
    pub fn claim(&mut self, stages: &[String], limit: u16, at: i64) -> Result<Vec<Claim>> {
        let tx = self.write()?;
        let mut select = tx.prepare(
            "SELECT e.instance,e.step,e.dispatch_count,e.max_duration,i.kind,i.entity,e.input_data,
                    json_extract(i.selection_inputs,'$.runId')
             FROM execution e JOIN instance i ON i.id=e.instance
             WHERE i.status='ACTIVE' AND i.current_step=e.step AND e.next_at<=?1
               AND e.stage IN (SELECT value FROM json_each(?2))
             ORDER BY e.next_at,e.instance LIMIT ?3",
        )?;
        let rows = select
            .query_map(params![at, serde_json::to_string(stages)?, limit], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, u32>(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get::<_, String>(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(select);
        let mut claims = Vec::new();
        for (instance, step, count, max_duration, kind, entity, input, run_id) in rows {
            let dispatch = count.checked_add(1).ok_or("dispatch overflow")?;
            let due = at
                .checked_add(i64::from(max_duration) + RECOVERY_MARGIN)
                .ok_or("timer overflow")?;
            tx.execute("UPDATE execution SET status='RUNNING',dispatch_count=?3,next_at=?4 WHERE instance=?1 AND step=?2",
                params![instance,step,dispatch,due])?;
            claims.push(Claim {
                instance,
                run_id,
                step,
                dispatch,
                max_duration,
                kind,
                entity,
                input: serde_json::from_str(&input)?,
            });
        }
        tx.commit()?;
        Ok(claims)
    }
    /// Returns false when recovery or another result has retired this invocation.
    pub fn record(&mut self, c: &Claim, outcome: Outcome, at: i64) -> Result<bool> {
        let tx = self.write()?;
        let current = tx.query_row(
            "SELECT e.attempts,e.max_attempts,d.spec FROM execution e
            JOIN instance i ON i.id=e.instance JOIN definition d ON d.name=i.name AND d.version=i.version
            WHERE e.instance=?1 AND e.step=?2 AND e.status='RUNNING' AND i.status='ACTIVE'
              AND i.current_step=e.step AND e.dispatch_count=?3
              AND json_extract(i.selection_inputs,'$.runId') IS ?4",
            params![c.instance,c.step,c.dispatch,c.run_id],
            |r| Ok((r.get::<_,u32>(0)?,r.get::<_,u32>(1)?,r.get::<_,String>(2)?)),
        ).optional()?;
        let Some((attempts, limit, json)) = current else {
            return Ok(false);
        };
        let definition: Definition = serde_json::from_str(&json)?;
        let policy = &definition.steps[&c.step];
        let mut next = None;
        let mut reason = None;
        let mut override_route = false;
        let mut charged = 0;
        let mut deferred = 0;
        let (mut state, mut detail, mut due) = match &outcome {
            Outcome::Done { route, .. } => {
                next = route
                    .as_ref()
                    .map(|r| r.target.as_str())
                    .or(policy.next.as_deref());
                if let Some(r) = route {
                    reason = Some(r.reason.as_str());
                    override_route = Some(&r.target) != policy.next.as_ref()
                        && !policy.alternates.contains(&r.target);
                }
                ("COMPLETED", "DONE", None)
            }
            Outcome::Retry { delay, reason: why } => {
                reason = Some(why.as_str());
                charged = 1;
                if attempts + 1 >= limit {
                    ("FAILED", "RETRY", None)
                } else {
                    (
                        "PENDING",
                        "RETRY",
                        Some(at.saturating_add(i64::from(*delay))),
                    )
                }
            }
            Outcome::Defer { delay } => {
                deferred = 1;
                (
                    "PENDING",
                    "DEFER",
                    Some(at.saturating_add(i64::from(*delay))),
                )
            }
            Outcome::Park { until } => ("PARKED", "PARK", Some(*until)),
            Outcome::Failed { reason: why } => {
                reason = Some(why.as_str());
                ("FAILED", "FAILED", None)
            }
        };
        if let Some(target) = next {
            let visited: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM execution WHERE instance=?1 AND step=?2)",
                params![c.instance, target],
                |r| r.get(0),
            )?;
            if !definition.steps.contains_key(target)
                || visited
                || reason.is_some_and(|r| r.trim().is_empty())
            {
                state = "FAILED";
                detail = "INVALID_ROUTE";
                due = None;
                reason = Some("unknown target, repeated step, or missing route reason");
                next = None;
                override_route = false;
            }
        }
        if state == "FAILED" && reason.is_none_or(|r| r.trim().is_empty()) {
            reason = Some("activity failed without a reason")
        }
        tx.execute(
            "UPDATE execution SET status=?3,last_outcome=?4,next_at=?5,attempts=attempts+?6,
            defer_count=defer_count+?7,last_error=?8 WHERE instance=?1 AND step=?2",
            params![
                c.instance,
                c.step,
                state,
                detail,
                due,
                charged,
                deferred,
                if state == "FAILED" || charged == 1 {
                    reason
                } else {
                    None
                }
            ],
        )?;
        tx.execute("INSERT INTO audit(instance,step,status,actor,detail,attempts,dispatch,default_target,target,was_override,reason)
            VALUES(?1,?2,?3,'activity',?4,?5,?6,?7,?8,?9,?10)",
            params![c.instance,c.step,state,detail,attempts+charged,c.dispatch,policy.next,next,override_route,reason],
        )?;
        if state == "COMPLETED" {
            if let (Some(target), Outcome::Done { payload, .. }) = (next, &outcome) {
                enqueue(
                    &tx,
                    c.instance,
                    target,
                    &definition.steps[target],
                    payload,
                    at,
                )?;
                tx.execute(
                    "UPDATE instance SET current_step=?2,last_progress_at=?3 WHERE id=?1",
                    params![c.instance, target, at],
                )?;
            } else {
                tx.execute("UPDATE instance SET status='COMPLETED',completed_at=?2,last_progress_at=?2 WHERE id=?1",
            params![c.instance,at])?;
            }
        } else if state == "FAILED" {
            tx.execute("UPDATE instance SET status='FAILED',failure_reason=?2,completed_at=?3,last_progress_at=?3 WHERE id=?1",
            params![c.instance,reason,at])?;
        }
        tx.commit()?;
        Ok(true)
    }
    pub fn retry(&mut self, id: i64, operator: &str, at: i64) -> Result<()> {
        if operator.trim().is_empty() {
            return Err("operator required".into());
        }
        let tx = self.write()?;
        let key: String = tx.query_row(
            "SELECT current_step FROM instance WHERE id=?1 AND status='FAILED'",
            [id],
            |r| r.get(0),
        )?;
        if tx.execute(
            "UPDATE execution SET status='PENDING',attempts=0,next_at=?3,last_error=NULL
            WHERE instance=?1 AND step=?2 AND status='FAILED'",
            params![id, key, at],
        )? != 1
        {
            return Err("step cannot be retried".into());
        }
        tx.execute("UPDATE instance SET status='ACTIVE',failure_reason=NULL,completed_at=NULL,last_progress_at=?2 WHERE id=?1",
            params![id,at])?;
        audit(&tx, id, &key, "operator", "RETRY", Some(operator))?;
        tx.commit()?;
        Ok(())
    }
}
