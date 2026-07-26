# frozen_string_literal: true

require "json"
require "psych"

class PolicyParseError < StandardError; end

def mapping_pairs(node)
  raise PolicyParseError unless node.is_a?(Psych::Nodes::Mapping)
  raise PolicyParseError unless node.children.length.even?

  seen = {}
  node.children.each_slice(2).map do |key, value|
    raise PolicyParseError unless key.is_a?(Psych::Nodes::Scalar)
    raise PolicyParseError if seen.key?(key.value)

    seen[key.value] = true
    [key.value, value]
  end
end

def mapping_value(node, name)
  pair = mapping_pairs(node).find { |key, _value| key == name }
  pair&.last
end

def scalar_value(node)
  raise PolicyParseError unless node.is_a?(Psych::Nodes::Scalar)
  raise PolicyParseError unless node.tag.nil? || node.tag == "tag:yaml.org,2002:str"

  node.value
end

def reject_aliases(node)
  raise PolicyParseError if node.is_a?(Psych::Nodes::Alias)

  Array(node.children).each { |child| reject_aliases(child) } if node.respond_to?(:children)
end

def collect_action_references(document)
  root = document.root
  raise PolicyParseError unless root.is_a?(Psych::Nodes::Mapping)

  jobs = mapping_value(root, "jobs")
  return [] if jobs.nil?
  raise PolicyParseError unless jobs.is_a?(Psych::Nodes::Mapping)

  references = []
  mapping_pairs(jobs).each do |_job_name, job|
    raise PolicyParseError unless job.is_a?(Psych::Nodes::Mapping)

    reusable = mapping_value(job, "uses")
    references << scalar_value(reusable) unless reusable.nil?

    steps = mapping_value(job, "steps")
    next if steps.nil?
    raise PolicyParseError unless steps.is_a?(Psych::Nodes::Sequence)

    steps.children.each do |step|
      raise PolicyParseError unless step.is_a?(Psych::Nodes::Mapping)

      action = mapping_value(step, "uses")
      references << scalar_value(action) unless action.nil?
    end
  end
  references
end

begin
  stream = Psych.parse_stream($stdin.read)
  raise PolicyParseError unless stream.children.length == 1

  document = stream.children.first
  reject_aliases(document)
  puts JSON.generate(collect_action_references(document))
rescue Psych::Exception, PolicyParseError, StandardError
  warn "workflow action parser failed"
  exit 1
end
