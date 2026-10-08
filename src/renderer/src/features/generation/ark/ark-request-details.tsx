import type { ArkRequestSummary } from '../../../../../shared/generation/ark-types';

const kindLabels = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
};
export function ArkRequestDetails({ request }: { request: ArkRequestSummary }) {
  const parameters = request.parameters;
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">服务</dt>
        <dd>火山方舟中国区</dd>
        <dt className="text-muted-foreground">提交模型 ID</dt>
        <dd className="break-all font-medium">{request.modelId}</dd>
        <dt className="text-muted-foreground">实际模型能力</dt>
        <dd>{request.capability}</dd>
        <dt className="text-muted-foreground">输出</dt>
        <dd>
          {parameters.resolution} ·{' '}
          {parameters.ratio === 'adaptive' ? '自动适配' : parameters.ratio}
          {request.imageSize && ` · ${request.imageSize}`}
          {'duration' in parameters &&
            ` · ${parameters.duration === -1 ? '智能时长' : `${parameters.duration} 秒`} · ${parameters.generateAudio ? '生成声音' : '不生成声音'}`}
        </dd>
        <dt className="text-muted-foreground">参考模式</dt>
        <dd>全能参考</dd>
      </dl>
      <div>
        <h3 className="mb-2 font-medium">实际发送的提示词（按文本块顺序）</h3>
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3">
          {request.prompt || '（没有文本提示词）'}
        </p>
      </div>
      <div>
        <h3 className="mb-2 font-medium">参考文件（发送顺序）</h3>
        {request.references.length ? (
          <ol className="max-h-44 space-y-2 overflow-y-auto rounded-lg border p-3">
            {request.references.map((reference, index) => (
              <li key={reference.nodeId} className="break-all">
                <span className="text-muted-foreground">
                  {index + 1}. {kindLabels[reference.kind]} ·{' '}
                </span>
                {reference.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {Math.max(1, Math.ceil(reference.bytes / 1024))} KB
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">没有参考文件</p>
        )}
      </div>
    </div>
  );
}
