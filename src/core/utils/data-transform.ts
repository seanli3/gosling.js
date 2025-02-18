import { ScaleLinear } from 'd3-scale';
import { assign } from 'lodash-es';
import {
    SingleTrack,
    Datum,
    FilterTransform,
    LogTransform,
    ExonSplitTransform,
    Assembly,
    StrConcatTransform,
    StrReplaceTransform,
    GenomicLengthTransform,
    CoverageTransform,
    CombineMatesTransform,
    DisplaceTransform,
    JSONParseTransform
} from '../gosling.schema';
import {
    getChannelKeysByAggregateFnc,
    getChannelKeysByType,
    IsChannelDeep,
    IsIncludeFilter,
    IsOneOfFilter,
    IsRangeFilter
} from '../gosling.schema.guards';
import { GET_CHROM_SIZES } from './assembly';
// import Logging from './log';

/**
 * Apply filter
 */
export function filterData(filter: FilterTransform, data: Datum[]): Datum[] {
    const { field, not } = filter;

    let output: Datum[] = Array.from(data);
    if (IsOneOfFilter(filter)) {
        const { oneOf } = filter;
        output = output.filter((d: Datum) => {
            return not ? (oneOf as any[]).indexOf(d[field]) === -1 : (oneOf as any[]).indexOf(d[field]) !== -1;
        });
    } else if (IsRangeFilter(filter)) {
        const { inRange } = filter;
        output = output.filter((d: Datum) => {
            return not
                ? !(inRange[0] <= d[field] && d[field] <= inRange[1])
                : inRange[0] <= d[field] && d[field] <= inRange[1];
        });
    } else if (IsIncludeFilter(filter)) {
        const { include } = filter;
        output = output.filter((d: Datum) => {
            return not ? `${d[field]}`.includes(include) : !`${d[field]}`.includes(include);
        });
    }
    return output;
}

/**
 * Calculate new data, like log transformation.
 */
export function concatString(concat: StrConcatTransform, data: Datum[]): Datum[] {
    const { fields, separator, newField } = concat;

    let output: Datum[] = Array.from(data);
    output = output.map(d => {
        const strs = fields.map(f => d[f]);
        d[newField] = strs.join(separator);
        return d;
    });
    return output;
}

export function replaceString(_: StrReplaceTransform, data: Datum[]): Datum[] {
    const { field, replace, newField } = _;

    let output: Datum[] = Array.from(data);
    output = output.map(d => {
        d[newField] = d[field]; // copy original string
        replace.forEach(r => {
            const { from, to } = r;
            d[newField] = d[newField].toString().replaceAll(from, to);
        });
        return d;
    });
    return output;
}

/**
 * Calculate new data, like log transformation.
 */
export function calculateData(log: LogTransform, data: Datum[]): Datum[] {
    const { field, base, newField } = log;

    let output: Datum[] = Array.from(data);
    output = output.map(d => {
        if (+d[field]) {
            if (base === 'e') {
                d[newField ?? field] = Math.log(+d[field]);
            } else {
                d[newField ?? field] = Math.log(+d[field]) / Math.log(base ?? 10);
            }
        }
        return d;
    });
    return output;
}

/**
 * Calculate genomic length using two genomic fields.
 */
export function calculateGenomicLength(_: GenomicLengthTransform, data: Datum[]): Datum[] {
    const { startField, endField, newField } = _;
    const output = Array.from(data);
    output.forEach(d => {
        const s = d[startField];
        const e = d[endField];
        if (!s || !e) {
            // such field does not exist, so skip this row
            // console.warn(`[Genomic Length] startField or endField (${s} or ${e}) does not exist.`);
            return;
        }
        d[newField] = Math.abs(+e - +s);
    });
    return output;
}

/**
 * Aggregate data rows and calculate coverage of reads.
 */
export function aggregateCoverage(_: CoverageTransform, data: Datum[], scale: ScaleLinear<any, any>): Datum[] {
    // Logging.recordTime('aggregateCoverage');

    const { startField, endField, newField, groupField } = _;

    const coverage: { [group: string]: { [position: string]: number } } = {};

    // Calculate coverage by one pixel.
    const binSize = 1;
    data.forEach(d => {
        const curStart = scale(d[startField] as number);
        const curEnd = scale(d[endField] as number);
        const group = groupField ? d[groupField] : '__NO_GROUP__';

        const adjustedStart = Math.floor(curStart);
        for (let i = adjustedStart; i < curEnd; i += binSize) {
            if (!coverage[group]) {
                coverage[group] = {};
            }
            if (!coverage[group][i]) {
                coverage[group][i] = 0;
            }
            coverage[group][i]++;
        }
    });

    const output = Object.entries(coverage).flatMap(group => {
        const [groupName, coverageRecords] = group;
        return Object.entries(coverageRecords).map(entry => {
            const [key, value] = entry;
            return {
                [startField]: scale.invert(+key),
                [endField]: scale.invert(+key + binSize),
                [newField ?? 'coverage']: value,
                [groupField ?? 'group']: groupName
            };
        });
    });

    // console.log(coverage);
    // Logging.printTime('aggregateCoverage');
    return output;
}

export function combineMates(t: CombineMatesTransform, data: Datum[]) {
    const { idField, maintainDuplicates } = t;
    const isLongField = t.isLongField ?? 'is_long';
    const maxInsertSize = t.maxInsertSize ?? 360;
    const copyData: { data: Datum; added: boolean }[] = data.map(d => {
        return { data: d, added: false };
    });
    const output: Datum[] = [];
    copyData.forEach((d, i) => {
        if (d.added) {
            // this row is added already, so just skip
            return;
        }
        if (i === copyData.length - 1) {
            // no additional reads to search for
            return;
        }

        if (!d.data[idField]) {
            // id does not exist
            console.warn(`[CombineMates] The id field (${idField}) does not exist.`);
            return;
        }

        const id = d.data[idField];
        const rest = copyData.slice(maintainDuplicates ? 0 : i + 1, copyData.length).filter((_, j) => i !== j);
        const mateIndex = rest.findIndex(r => r.data[idField] === id);
        if (mateIndex === -1) {
            // no mate found. this read will not be included to the result data.
            return;
        }
        const mate = copyData[mateIndex];
        const newRow: Datum = {};
        // assuming that keys are the same for mates
        Object.keys(d.data).forEach(k => {
            // if not maintaining duplicated rows, left mate should be stored in the first field
            const [f, s] = maintainDuplicates ? [d, mate] : [d, mate].sort((a, b) => +a.data.from - +b.data.from);
            newRow[`${k}`] = f.data[k];
            newRow[`${k}_2`] = s.data[k];

            const [left, right] = [d, mate].sort((a, b) => +a.data.from - +b.data.from);
            newRow[isLongField] = Math.abs(+left.data.to - +right.data.from) >= maxInsertSize ? 'true' : 'false';
        });
        output.push(newRow);

        if (!maintainDuplicates) {
            mate.added = true; // set a flag so that we can skip this later
        }
    });
    return output;
}

export function displace(t: DisplaceTransform, data: Datum[], scale: ScaleLinear<any, any>): Datum[] {
    // Logging.recordTime('displace()');

    const { boundingBox, method, newField } = t;
    const { startField, endField, groupField } = boundingBox;

    let padding = 0; // This is a pixel value.
    if (boundingBox.padding && scale && !boundingBox.isPaddingBP) {
        padding = Math.abs(scale.invert(boundingBox.padding) - scale.invert(0));
    } else if (boundingBox.padding && boundingBox.isPaddingBP) {
        padding = boundingBox.padding;
    }

    // Check whether we have sufficient information.
    const base = Array.from(data);
    if (base && base.length > 0) {
        if (!Object.keys(base[0]).find(d => d === startField) || !Object.keys(base[0]).find(d => d === endField)) {
            // We did not find the fields from the data, so exit here.
            return base;
        }
    }

    if (method === 'pile') {
        const oldAlgorithm = false;

        if (oldAlgorithm) {
            // This will be deprecated soon.
            const { maxRows } = t;
            const boundingBoxes: { start: number; end: number; row: number }[] = [];

            base.sort((a: Datum, b: Datum) => (a[startField] as number) - (b[startField] as number)).forEach(
                (d: Datum) => {
                    const start = (d[startField] as number) - padding;
                    const end = (d[endField] as number) + padding;

                    const overlapped = boundingBoxes.filter(
                        box =>
                            (box.start === start && end === box.end) ||
                            (box.start <= start && start < box.end) ||
                            (box.start < end && end <= box.end) ||
                            (start < box.start && box.end < end)
                    );

                    // find the lowest non overlapped row
                    const uniqueRows = [
                        ...Array.from(new Set(boundingBoxes.map(d => d.row))),
                        Math.max(...boundingBoxes.map(d => d.row)) + 1
                    ];
                    const overlappedRows = overlapped.map(d => d.row);
                    const lowestNonOverlappedRow = Math.min(
                        ...uniqueRows.filter(d => overlappedRows.indexOf(d) === -1)
                    );

                    // row index starts from zero
                    const row: number = overlapped.length === 0 ? 0 : lowestNonOverlappedRow;

                    d[newField] = `${maxRows && maxRows <= row ? maxRows - 1 : row}`;

                    boundingBoxes.push({ start, end, row });
                }
            );
        } else {
            // This piling algorithm is heavily based on
            // https://github.com/higlass/higlass-pileup/blob/8538a34c6d884c28455d6178377ee1ea2c2c90ae/src/bam-fetcher-worker.js#L626
            const { maxRows } = t;
            const occupiedSpaceInRows: { [group: string]: { start: number; end: number }[] } = {};

            const sorted = base.sort((a: Datum, b: Datum) => (a[startField] as number) - (b[startField] as number));

            sorted.forEach((d: Datum) => {
                const start = (d[startField] as number) - padding;
                const end = (d[endField] as number) + padding;

                // Create object if none
                const group = groupField ? d[groupField] : '__NO_GROUP__';
                if (!occupiedSpaceInRows[group]) {
                    occupiedSpaceInRows[group] = [];
                }

                // Find a row to place this segment
                let rowIndex = occupiedSpaceInRows[group].findIndex(d => {
                    // Find a space and update the occupancy info.
                    if (end < d.start) {
                        d.start = start;
                        return true;
                    } else if (d.end < start) {
                        d.end = end;
                        return true;
                    }
                    return false;
                });

                if (rowIndex === -1) {
                    // We did not find sufficient space from the existing rows, so add a new row.
                    occupiedSpaceInRows[group].push({ start, end });
                    rowIndex = occupiedSpaceInRows[group].length - 1;
                }

                d[newField] = `${maxRows && maxRows <= rowIndex ? maxRows - 1 : rowIndex}`;
            });
        }
    } else if (method === 'spread') {
        const boundingBoxes: { start: number; end: number }[] = [];

        base.sort((a: Datum, b: Datum) => (a[startField] as number) - (b[startField] as number)).forEach((d: Datum) => {
            let start = (d[startField] as number) - padding;
            let end = (d[endField] as number) + padding;

            let overlapped = boundingBoxes.filter(
                box =>
                    (box.start === start && end === box.end) ||
                    (box.start < start && start < box.end) ||
                    (box.start < end && end < box.end) ||
                    (start < box.start && box.end < end)
            );

            if (overlapped.length > 0) {
                let trial = 0;
                do {
                    overlapped = boundingBoxes.filter(
                        box =>
                            (box.start === start && end === box.end) ||
                            (box.start < start && start < box.end) ||
                            (box.start < end && end < box.end) ||
                            (start < box.start && box.end < end)
                    );
                    if (overlapped.length > 0) {
                        if (trial % 2 === 0) {
                            start += padding * trial;
                            end += padding * trial;
                        } else {
                            start -= padding * trial;
                            end -= padding * trial;
                        }
                    }
                    trial++;
                    // TODO: do not go outside of a tile.
                } while (overlapped.length > 0 && trial < 1000);
            }

            d[`${newField}Start`] = `${start + padding}`;
            d[`${newField}Etart`] = `${end - padding}`;

            boundingBoxes.push({ start, end });
        });
    }

    // Logging.printTime('displace()');
    return base;
}

export function splitExon(split: ExonSplitTransform, data: Datum[], assembly: Assembly = 'hg38'): Datum[] {
    const { separator, fields, flag } = split;
    let output: Datum[] = Array.from(data);
    output = output
        .map((d: Datum) => {
            const newRows: Datum[] = [];

            fields.forEach(f => {
                const { field, type, newField, chrField } = f;
                const splitted = d[field].toString().split(separator);

                splitted.forEach((s, i) => {
                    let newValue: string | number = s;
                    if (type === 'genomic') {
                        newValue = GET_CHROM_SIZES(assembly).interval[d[chrField]][0] + +s;
                    }
                    if (!newRows[i]) {
                        // No row exist, so create one.
                        newRows[i] = assign(JSON.parse(JSON.stringify(d)), {
                            [newField]: newValue,
                            [flag.field]: flag.value
                        });
                    } else {
                        newRows[i][newField] = newValue;
                    }
                });
            });
            return [d, ...newRows];
        })
        .reduce((a, b) => a.concat(b), []);
    return output;
}

// TODO: Get this data from the fetcher as a default with a flag variable.
export function parseSubJSON(_: JSONParseTransform, data: Datum[]): Datum[] {
    const { field, genomicField, baseGenomicField, genomicLengthField } = _;
    let output: Datum[] = Array.from(data);
    output = output
        .map((d: Datum) => {
            let newRows: Datum[] = JSON.parse(d[field] as string);

            newRows = newRows.map(row => {
                if (row[genomicField] && d[baseGenomicField]) {
                    row[`${genomicField}_start`] = +row[genomicField] + +d[baseGenomicField];
                    row[`${genomicField}_end`] = +row[genomicField] + +d[baseGenomicField] + +row[genomicLengthField];
                }

                return assign(JSON.parse(JSON.stringify(d)), {
                    ...row,
                    [`${genomicField}_start`]: row[`${genomicField}_start`],
                    [`${genomicField}_end`]: row[`${genomicField}_end`],
                    type: row.type ?? row.variant ?? null,
                    isParsedRow: 'yes'
                });
            });

            return [d, ...newRows];
        })
        .reduce((a, b) => a.concat(b), []);
    return output;
}

/**
 * Experimental! Only support one category supported yet.
 */
export function aggregateData(spec: SingleTrack, data: Datum[]): Datum[] {
    if (getChannelKeysByAggregateFnc(spec).length === 0) {
        // we do not have aggregated fields
        return data;
    }

    const nChannelKeys = getChannelKeysByType(spec, 'nominal');

    if (nChannelKeys.length !== 1) {
        console.warn('Currently, we only support aggregating datasets with single nominal field.');
        return data;
    }

    const nFieldSpec = spec[nChannelKeys[0]];
    if (!IsChannelDeep(nFieldSpec)) {
        // this shouldn't be reached
        return data;
    }

    const nField = nFieldSpec.field;
    if (!nField) {
        // this shouldn't be reached
        return data;
    }

    const qChannelKeys = [...getChannelKeysByType(spec, 'quantitative'), ...getChannelKeysByType(spec, 'genomic')];
    const aggregated: { [k: string]: number | string }[] = [];

    const uniqueCategories = Array.from(new Set(data.map(d => d[nField])));

    let failed = false;
    uniqueCategories.forEach(c => {
        const datum: { [k: string]: string | number } = {};

        datum[nField] = c;

        // for each quantitative fields
        qChannelKeys.forEach(q => {
            const qFieldSpec = spec[q];
            if (!IsChannelDeep(qFieldSpec)) {
                // this shouldn't be reached
                failed = true;
                return;
            }

            const { field: qField } = qFieldSpec;
            if (!qField || !('aggregate' in qFieldSpec)) {
                // this shouldn't be reached
                failed = true;
                return;
            }

            datum[qField] =
                qFieldSpec.aggregate === 'max'
                    ? Math.max(...data.filter(d => d[nField] === c).map(d => +d[qField]))
                    : Math.min(...data.filter(d => d[nField] === c).map(d => +d[qField]));
        });

        aggregated.push(datum);
    });

    // set aggregated data only if we successfully generated it
    return !failed ? aggregated : data;
}
