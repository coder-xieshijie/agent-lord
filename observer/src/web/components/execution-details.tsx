import type { CallerLifecycle, TaskMeta } from "../../shared/types";
import { CopyButton } from "./copy-button";

export function callerStatus(lifecycle: CallerLifecycle | undefined): string {
  return lifecycle?.status === "running" ? "主调度仍在进行" : lifecycle?.status === "completed" ? "主调度本轮已结束"
    : lifecycle?.status === "aborted" ? "主调度本轮已中止" : "主调度状态未知";
}
function verification(value: string | null | undefined): string {
  return value === "provider-metadata" ? "运行端元信息已核验"
    : value === "argument-enforced" || value === "config-argument-enforced" ? "由启动参数约束"
      : value === "not-supported" ? "运行端不支持" : value === "not-requested" ? "未指定" : value ?? "未核验";
}
function Row({ name, value, missing = "未记录", note }: { name: string; value: string | null | undefined; missing?: string; note?: string }) {
  return <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 text-xs">
    <span className="w-28 shrink-0 text-muted-foreground">{name}</span>
    <div className="min-w-0 flex-1 break-all"><span>{value ?? missing}</span>{note && <span className="ml-2 text-muted-foreground">（{note}）</span>}</div>
    {value && <CopyButton text={value} label={`复制${name}`} />}
  </div>;
}
function time(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, fractionalSecondDigits: 3,
  }) : null;
}
export function elapsed(start: number | null | undefined, end: number | null | undefined): string | null {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end < start ? "时间顺序异常" : `${((end - start) / 1000).toFixed(2)} 秒`;
}
export function ExecutionDetails({ meta }: { meta: TaskMeta }) {
  const model = meta.execution;
  const mcode = meta.provider === "mcode-cli";
  const identitySource = (source: string | undefined) => source === "runtime-env" ? "宿主环境" : source === "caller-declared" ? "调用方声明" : "未记录";
  const timing = meta.timing;
  return <div className="space-y-2 border-b pb-3">
    <Row name="请求模型" value={model?.requestedModel ?? meta.model} />
    <Row name="实际模型" value={model?.actualModel} missing="运行端未回报" note={verification(model?.modelVerification)} />
    <Row name={mcode ? "请求推理档位" : "请求 Effort"} value={mcode ? model?.requestedVariant : model?.requestedEffort} missing="未指定" note={mcode ? "MCode variant" : undefined} />
    <Row name={mcode ? "实际推理档位" : "执行 Effort"} value={mcode ? model?.actualVariant : model?.actualEffort} missing="未回报" note={verification(mcode ? model?.variantVerification : model?.effortVerification)} />
    <Row name="最初调度 Session" value={meta.caller?.initial?.session_id} note={identitySource(meta.caller?.initial?.identity_source)} />
    <Row name="本轮调度 Session" value={meta.caller?.current?.session_id} note={identitySource(meta.caller?.current?.identity_source)} />
    <Row name="调度者" value={meta.caller?.current?.kind} />
    <Row name="调度 Turn" value={meta.caller?.lifecycle.turnId ?? meta.caller?.current?.turn_id} />
    <p className="text-xs text-muted-foreground">{callerStatus(meta.caller?.lifecycle)}。{meta.caller?.lifecycle.note}</p>
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">完成时间与收尾耗时</summary>
      <div className="mt-2 space-y-2">
        <Row name="执行端结束" value={time(timing?.providerCompletedAtMs)} missing="未观测" />
        <Row name="产物发布" value={time(timing?.artifactReadyAtMs)} missing="未观测" />
        <Row name="主调度收到结果" value={time(timing?.callerReceivedAtMs)} missing="未观测" />
        <Row name="主调度结束" value={time(timing?.callerCompletedAtMs)} missing="未观测" />
        <Row name="发布至收到结果" value={elapsed(timing?.artifactReadyAtMs, timing?.callerReceivedAtMs)} missing="未观测" />
        <Row name="收到至调度结束" value={elapsed(timing?.callerReceivedAtMs, timing?.callerCompletedAtMs)} missing="未观测" />
      </div>
    </details>
  </div>;
}
