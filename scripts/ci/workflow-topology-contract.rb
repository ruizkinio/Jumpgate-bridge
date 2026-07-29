# frozen_string_literal: true

require "json"
require "psych"

class ContractParseError < StandardError; end

def mapping_pairs(node)
  raise ContractParseError unless node.is_a?(Psych::Nodes::Mapping)
  raise ContractParseError unless node.children.length.even?

  seen = {}
  node.children.each_slice(2).map do |key, value|
    raise ContractParseError unless key.is_a?(Psych::Nodes::Scalar)
    raise ContractParseError if seen.key?(key.value)

    seen[key.value] = true
    [key.value, value]
  end
end

def mapping_value(node, name)
  mapping_pairs(node).find { |key, _value| key == name }&.last
end

def scalar_value(node)
  return nil if node.nil?
  raise ContractParseError unless node.is_a?(Psych::Nodes::Scalar)

  node.value
end

def scalar_mapping(node)
  return nil if node.nil?

  mapping_pairs(node).to_h do |key, value|
    [key, scalar_value(value)]
  end
end

def scalar_or_sequence(node)
  return nil if node.nil?
  return scalar_value(node) if node.is_a?(Psych::Nodes::Scalar)
  raise ContractParseError unless node.is_a?(Psych::Nodes::Sequence)

  node.children.map { |value| scalar_value(value) }
end

def literal_node(node)
  return nil if node.nil?
  return scalar_value(node) if node.is_a?(Psych::Nodes::Scalar)
  return node.children.map { |value| literal_node(value) } if node.is_a?(Psych::Nodes::Sequence)
  if node.is_a?(Psych::Nodes::Mapping)
    return mapping_pairs(node).to_h do |key, value|
      [key, literal_node(value)]
    end
  end

  raise ContractParseError
end

def inspect_defaults(node)
  return nil if node.nil?

  pairs = mapping_pairs(node)
  run = mapping_value(node, "run")
  run_pairs = run.nil? ? [] : mapping_pairs(run)
  {
    "keys" => pairs.map(&:first),
    "runKeys" => run_pairs.map(&:first),
    "shell" => run.nil? ? nil : scalar_value(mapping_value(run, "shell")),
    "workingDirectory" =>
      run.nil? ? nil : scalar_value(mapping_value(run, "working-directory")),
  }
end

def inspect_step(job_name, step)
  pairs = mapping_pairs(step)
  {
    "job" => job_name,
    "keys" => pairs.map(&:first),
    "name" => scalar_value(mapping_value(step, "name")),
    "id" => scalar_value(mapping_value(step, "id")),
    "if" => scalar_value(mapping_value(step, "if")),
    "run" => scalar_value(mapping_value(step, "run")),
    "uses" => scalar_value(mapping_value(step, "uses")),
    "shell" => scalar_value(mapping_value(step, "shell")),
    "workingDirectory" => scalar_value(mapping_value(step, "working-directory")),
    "timeoutMinutes" => scalar_value(mapping_value(step, "timeout-minutes")),
    "continueOnError" => scalar_value(mapping_value(step, "continue-on-error")),
    "env" => scalar_mapping(mapping_value(step, "env")),
    "with" => scalar_mapping(mapping_value(step, "with")),
  }
end

def reject_aliases(node)
  raise ContractParseError if node.is_a?(Psych::Nodes::Alias)

  Array(node.children).each { |child| reject_aliases(child) } if node.respond_to?(:children)
end

def inspect_workflow(document)
  root = document.root
  raise ContractParseError unless root.is_a?(Psych::Nodes::Mapping)
  root_pairs = mapping_pairs(root)

  jobs = mapping_value(root, "jobs")
  raise ContractParseError unless jobs.is_a?(Psych::Nodes::Mapping)

  inspected_jobs = mapping_pairs(jobs).to_h do |job_name, job|
    raise ContractParseError unless job.is_a?(Psych::Nodes::Mapping)

    job_pairs = mapping_pairs(job)
    job_steps = mapping_value(job, "steps")
    unless job_steps.nil? || job_steps.is_a?(Psych::Nodes::Sequence)
      raise ContractParseError
    end
    inspected_steps = Array(job_steps&.children).map do |step|
      raise ContractParseError unless step.is_a?(Psych::Nodes::Mapping)

      inspect_step(job_name, step)
    end

    [job_name, {
      "keys" => job_pairs.map(&:first),
      "name" => scalar_value(mapping_value(job, "name")),
      "needs" => scalar_or_sequence(mapping_value(job, "needs")),
      "if" => scalar_value(mapping_value(job, "if")),
      "runsOn" => scalar_value(mapping_value(job, "runs-on")),
      "timeoutMinutes" => scalar_value(mapping_value(job, "timeout-minutes")),
      "permissions" => scalar_mapping(mapping_value(job, "permissions")),
      "strategy" => literal_node(mapping_value(job, "strategy")),
      "services" => literal_node(mapping_value(job, "services")),
      "env" => scalar_mapping(mapping_value(job, "env")),
      "environment" => scalar_mapping(mapping_value(job, "environment")),
      "concurrency" => scalar_mapping(mapping_value(job, "concurrency")),
      "hasContainer" => !mapping_value(job, "container").nil?,
      "defaults" => inspect_defaults(mapping_value(job, "defaults")),
      "outputs" => scalar_mapping(mapping_value(job, "outputs")),
      "steps" => inspected_steps,
    }]
  end

  {
    "rootKeys" => root_pairs.map(&:first),
    "globalEnv" => scalar_mapping(mapping_value(root, "env")),
    "globalDefaults" => inspect_defaults(mapping_value(root, "defaults")),
    "jobs" => inspected_jobs,
  }
end

begin
  stream = Psych.parse_stream($stdin.read)
  raise ContractParseError unless stream.children.length == 1

  document = stream.children.first
  reject_aliases(document)
  puts JSON.generate(inspect_workflow(document))
rescue Psych::Exception, ContractParseError, StandardError
  warn "workflow topology parser failed"
  exit 1
end
