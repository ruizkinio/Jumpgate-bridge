# frozen_string_literal: true

require "json"
require "psych"

class ReleaseMetadataParseError < StandardError; end

def mapping_pairs(node)
  raise ReleaseMetadataParseError unless node.is_a?(Psych::Nodes::Mapping)
  raise ReleaseMetadataParseError unless node.children.length.even?

  seen = {}
  node.children.each_slice(2).map do |key, value|
    raise ReleaseMetadataParseError unless key.is_a?(Psych::Nodes::Scalar)
    raise ReleaseMetadataParseError if seen.key?(key.value)

    seen[key.value] = true
    [key.value, value]
  end
end

def mapping_value(node, name)
  mapping_pairs(node).find { |key, _value| key == name }&.last
end

def scalar_value(node)
  raise ReleaseMetadataParseError unless node.is_a?(Psych::Nodes::Scalar)
  raise ReleaseMetadataParseError unless node.tag.nil? || node.tag == "tag:yaml.org,2002:str"

  node.value
end

def literal_node(node)
  return nil if node.nil?
  return node.value if node.is_a?(Psych::Nodes::Scalar)
  return node.children.map { |value| literal_node(value) } if node.is_a?(Psych::Nodes::Sequence)
  if node.is_a?(Psych::Nodes::Mapping)
    return mapping_pairs(node).to_h do |key, value|
      [key, literal_node(value)]
    end
  end

  raise ReleaseMetadataParseError
end

def reject_aliases(node)
  raise ReleaseMetadataParseError if node.is_a?(Psych::Nodes::Alias)

  Array(node.children).each { |child| reject_aliases(child) } if node.respond_to?(:children)
end

def release_metadata(document)
  root = document.root
  raise ReleaseMetadataParseError unless root.is_a?(Psych::Nodes::Mapping)

  triggers = mapping_value(root, "on")
  jobs = mapping_value(root, "jobs")
  raise ReleaseMetadataParseError unless triggers.is_a?(Psych::Nodes::Mapping)
  raise ReleaseMetadataParseError unless jobs.is_a?(Psych::Nodes::Mapping)

  inspected_jobs = mapping_pairs(jobs).to_h do |job_id, job|
    raise ReleaseMetadataParseError unless job.is_a?(Psych::Nodes::Mapping)

    [job_id, {
      "name" => scalar_value(mapping_value(job, "name")),
      "strategy" => literal_node(mapping_value(job, "strategy")),
    }]
  end

  {
    "triggers" => literal_node(triggers),
    "jobs" => inspected_jobs,
  }
end

begin
  stream = Psych.parse_stream($stdin.read)
  raise ReleaseMetadataParseError unless stream.children.length == 1

  document = stream.children.first
  reject_aliases(document)
  puts JSON.generate(release_metadata(document))
rescue Psych::Exception, ReleaseMetadataParseError, StandardError
  warn "workflow release metadata parser failed"
  exit 1
end
