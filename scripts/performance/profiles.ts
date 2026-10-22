import { number, object, text } from "./model";

/** Decode Grafana's flamegraph frame, including dictionary-encoded labels. */
export function hotFrames(value: unknown) {
  const result = object(object(object(value).results).A);
  if (result.error) throw new Error(text(result.error));
  if (!Array.isArray(result.frames)) throw new Error("Missing profiling frames");
  const frames = result.frames.flatMap((item: unknown) => {
    const frame = object(item);
    const schema = object(frame.schema);
    const data = object(frame.data);
    if (!Array.isArray(schema.fields) || !Array.isArray(data.values))
      throw new Error("Invalid profile frame");
    const fields = schema.fields.map(object);
    const labelIndex = fields.findIndex((field) => field.name === "label");
    const selfIndex = fields.findIndex((field) => field.name === "self");
    const labelField = fields[labelIndex];
    if (!labelField || selfIndex < 0) return [];
    const labels: unknown = data.values[labelIndex];
    const weights: unknown = data.values[selfIndex];
    if (!Array.isArray(labels) || !Array.isArray(weights))
      throw new Error("Invalid profile values");
    let dictionary: string[] | undefined;
    if (labelField.type === "enum") {
      const values = object(object(object(labelField.config).type).enum).text;
      if (!Array.isArray(values)) throw new Error("Invalid profile labels");
      dictionary = values.map(text);
    }
    return labels.map((value: unknown, index: number) => {
      const label = dictionary ? dictionary[number(value)] : text(value);
      if (!label) throw new Error("Unknown profile label");
      return { label, sampledSelfNs: number(weights[index]) };
    });
  });
  const totals = new Map<string, number>();
  for (const frame of frames)
    totals.set(frame.label, (totals.get(frame.label) ?? 0) + frame.sampledSelfNs);
  return [...totals]
    .map(([label, sampledSelfNs]) => ({ label, sampledSelfNs }))
    .filter((frame) => frame.sampledSelfNs > 0)
    .sort((a, b) => b.sampledSelfNs - a.sampledSelfNs)
    .slice(0, 25);
}
